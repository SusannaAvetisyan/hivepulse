/** Lifecycle states planned for the in-memory engine. */
export type JobStatus = 'waiting' | 'active' | 'completed' | 'failed';

/** A handler receives job context and resolves with its result. */
export type JobHandler<TContext = unknown, TResult = unknown> =
  (context: TContext) => Promise<TResult> | TResult;

/** Engine configuration. Concurrency defaults to one. */
export interface HivePulseOptions {
  concurrency?: number;
}

/** Input for synchronous job submission. */
export interface AddJobOptions<TContext = unknown> {
  type: string;
  context: TContext;
  properties?: Record<string, unknown>;
}
