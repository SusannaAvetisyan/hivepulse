import { setImmediate } from 'node:timers';
import { v4 as uuidv4 } from 'uuid';
import { HandlerAlreadyRegisteredError } from '../errors/HandlerAlreadyRegisteredError.js';
import { HandlerNotRegisteredError } from '../errors/HandlerNotRegisteredError.js';

import { JobStatus, type Job } from './Job.js';
import type { AddJobOptions, HivePulseOptions, JobHandler } from './types.js';

// Bound uninterrupted starts so fast handlers cannot monopolize the microtask queue.
const STARTS_BEFORE_YIELD = 64;

/** In-memory FIFO job engine with bounded concurrency. */
export class HivePulse {
  private readonly concurrency: number;
  private readonly handlers: Map<string, JobHandler<unknown, unknown>>;
  private readonly jobs: Map<string, Job>;
  private readonly queue: Job[];
  private activeCount: number;
  private schedulePending = false;
  private startsSinceYield = 0;
  private readonly idleWaiters = new Set<() => void>();

  constructor(options: HivePulseOptions = {}) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('HivePulse options must be an object');
    }

    const concurrency = options.concurrency === undefined ? 1 : options.concurrency;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new RangeError('HivePulse concurrency must be a positive safe integer');
    }

    this.concurrency = concurrency;
    this.handlers = new Map();
    this.jobs = new Map();
    this.queue = [];
    this.activeCount = 0;
  }

  /** Register a handler for a job type. */
  register<TContext = unknown, TResult = unknown>(
    _type: string,
    _handler: JobHandler<TContext, TResult>,
  ): void {
    if (this.handlers.has(_type)) {
      throw new HandlerAlreadyRegisteredError(_type);
    }
    if (typeof _handler !== 'function') {
      throw new TypeError('HivePulse handler must be a function');
    }
    // The heterogeneous registry erases each handler's context type at this boundary.
    this.handlers.set(_type, context => _handler(context as TContext));
  }

  /** Validate the handler and return a job ID synchronously; execute later. */
  add<TContext = unknown>(_options: AddJobOptions<TContext>): string {
    const handler = this.handlers.get(_options.type);
    if(!handler)
    {
      throw new HandlerNotRegisteredError(_options.type);
    }
    const job: Job<TContext, unknown> = {
      id: uuidv4(),
      type: _options.type,
      context: _options.context,
      properties: { ..._options.properties },
      attempts: 0,
      status: JobStatus.WAITING,
      createdAt: new Date()
    };
  
    this.jobs.set(job.id, job);

    this.queue.push(job);
    this.requestSchedule();

    return job.id;
  }

  /** Return an independent snapshot; payloads must support structured cloning. */
  getJob(_id: string): Job | undefined {
    const job = this.jobs.get(_id);
    return job === undefined ? undefined : structuredClone(job);
  }

  /** Wait until the engine next has no active or waiting jobs. */
  onIdle(): Promise<void> {
    if (this.activeCount === 0 && this.queue.length === 0) {
      return Promise.resolve();
    }
    return new Promise(resolve => this.idleWaiters.add(resolve));
  }

  private requestSchedule(): void {
    if (this.schedulePending || this.queue.length === 0 || this.activeCount >= this.concurrency) {
      return;
    }
    this.schedulePending = true;
    const run = () => {
      this.schedulePending = false;
      this.schedule();
    };
    if (this.startsSinceYield >= STARTS_BEFORE_YIELD) {
      setImmediate(() => {
        this.startsSinceYield = 0;
        run();
      });
    } else {
      queueMicrotask(run);
    }
  }

  private schedule(): void {
    if(this.activeCount < this.concurrency)
    {
      const jobsToExecute = [];
      const capacity = Math.min(this.concurrency - this.activeCount, STARTS_BEFORE_YIELD - this.startsSinceYield);
      for(let i=0; i< capacity; i++)
      {
        const job = this.queue.shift();
        if(!job)
        {
          break;
        }
      
        job.startedAt = new Date();
        job.attempts += 1;
        job.status = JobStatus.ACTIVE;
        jobsToExecute.push(job);
      }

      this.activeCount += jobsToExecute.length;
      this.startsSinceYield += jobsToExecute.length;

      for (const job of jobsToExecute) void this.execute(job);
      this.requestSchedule();
    }
  }

  private async execute(_job: Job): Promise<void> {
    try
    {
      const handler = this.handlers.get(_job.type);
      if(!handler)
      {
        throw new HandlerNotRegisteredError(_job.type);
      }
      _job.result = await handler(_job.context);
      _job.status = JobStatus.COMPLETED;
    }
    catch(e)
    {
      _job.status = JobStatus.FAILED;
      if(e instanceof Error)
      {
        _job.error = e;
      }
      else
      {
        _job.error = new Error("Unknown error", { cause: e });
      }
    }
    finally
    {
      _job.finishedAt = new Date();
      this.activeCount -= 1;
      this.requestSchedule();
      if (this.activeCount === 0 && this.queue.length === 0) {
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
      }
    }
  }
}
