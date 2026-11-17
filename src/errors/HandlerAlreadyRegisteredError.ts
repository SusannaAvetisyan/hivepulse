/** Thrown when registering a handler for an existing job type. */
export class HandlerAlreadyRegisteredError extends Error {
  constructor(readonly jobType: string) {
    super(`Handler already registered for job type "${jobType}"`);
    this.name = 'HandlerAlreadyRegisteredError';
  }
}
