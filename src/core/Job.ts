import type { JobStatus as JobStatusType } from './types.js';


export enum JobStatus {
  WAITING = 'waiting',
  ACTIVE = 'active',
  COMPLETED = 'completed',
  FAILED = 'failed'
}

/** A job record for the planned in-memory engine. */
export interface Job<TContext = unknown, TResult = unknown> {
  id: string;
  type: string;
  status: JobStatusType;
  context: TContext;
  properties: Record<string, unknown>;
  attempts: number;
  result?: TResult;
  error?: Error;
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
}
