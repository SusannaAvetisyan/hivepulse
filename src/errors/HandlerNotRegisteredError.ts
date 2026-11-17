/** Thrown when a job is submitted without a registered handler. */
export class HandlerNotRegisteredError extends Error {
  readonly jobType: string;

  constructor(jobType: string) {
    super(`No handler registered for job type "${jobType}"`);
    this.name = 'HandlerNotRegisteredError';
    this.jobType = jobType;
  }
}
