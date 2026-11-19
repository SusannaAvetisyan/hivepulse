# HivePulse

In-memory job processing for Node.js and TypeScript.

Register a handler, submit a job, and let HivePulse manage execution. Jobs start
in FIFO order with a configurable concurrency limit, and each job retains its
status, result, and error for lookup.

**v0.1.1 · First Buzz**

- Synchronous and asynchronous handlers
- FIFO scheduling with bounded concurrency and periodic event-loop yields
- Job snapshots with results, errors, timestamps, and attempt counts
- `onIdle()` for waiting until queued and active work finishes
- ESM exports and TypeScript declarations

HivePulse is suited to temporary work within a single Node.js process. It does
not persist jobs: queued work and stored results are lost when the process exits.

## Installation

Requires **Node.js 22.12 or later**. HivePulse is ESM-only.

```sh
npm install hivepulse
```

To use a local checkout instead, first build it:

```sh
# In the hivepulse-lib directory
npm ci
npm run build
```

Then install it from your application, adjusting the path to your checkout:

```sh
npm install ../hivepulse-lib
```

## Quick start

```js
import { HivePulse } from 'hivepulse';

const engine = new HivePulse({ concurrency: 2 });

engine.register('calculate-total', ({ prices }) => {
  return prices.reduce((total, price) => total + price, 0);
});

const jobId = engine.add({
  type: 'calculate-total',
  context: { prices: [12, 18, 25] },
  properties: { orderId: 'order-123' },
});

console.log(engine.getJob(jobId)?.status); // waiting

await engine.onIdle();

const job = engine.getJob(jobId);
console.log(job?.status); // completed
console.log(job?.result); // 55
```

Save the example as an `.mjs` file, or use a project with `"type": "module"`.
`add()` returns the job ID before a handler starts. FIFO determines start order;
completion order depends on how long each handler takes. Large bursts periodically
yield to the event loop so timers and I/O can progress; free slots may therefore
be filled on a later event-loop turn.

## API

### `new HivePulse(options?)`

| Option | Default | Description |
| --- | --- | --- |
| `concurrency` | `1` | Maximum active jobs. Must be a positive safe integer. |

Invalid concurrency values throw `RangeError`. When a job finishes or fails,
its execution slot becomes available to the next waiting job.

### `register(type, handler)`

Registers one handler for a job type. The handler receives the job's `context`
and can return a value or a promise. Handlers remain registered for the lifetime
of the engine and cannot be replaced or removed.

Registering the same type twice throws `HandlerAlreadyRegisteredError`.
A non-function handler throws `TypeError` without registering the type.

For TypeScript, declare the handler's input type:

```ts
import { HivePulse } from 'hivepulse';

const engine = new HivePulse();

type TotalInput = { prices: number[] };

engine.register('calculate-total', ({ prices }: TotalInput) =>
  prices.reduce((total, price) => total + price, 0),
);
```

Handler and submission types are independent in v0.1.0. The caller is responsible
for matching a job's context to its registered handler; payloads are not validated
at runtime. Results returned by `getJob()` have type `unknown` until narrowed.

### `add({ type, context, properties? }): string`

Creates a job, places it in the waiting queue, and returns its unique ID
synchronously. Scheduling is deferred until after the call returns.

`properties` stores optional metadata and defaults to `{}`. An unknown job type
throws `HandlerNotRegisteredError` before a job is created.

### `getJob(id): Job | undefined`

Returns an independent deep snapshot, or `undefined` if the ID is unknown.
Fetch another snapshot to observe later changes.

| Field | Description |
| --- | --- |
| `id`, `type` | Job identity and registered handler type |
| `context`, `properties` | Handler input and metadata |
| `status` | `waiting`, `active`, `completed`, or `failed` |
| `result` | Handler return value after successful execution |
| `error` | Captured `Error` after failure |
| `attempts` | `0` while waiting; `1` after execution starts |
| `createdAt` | Submission time |
| `startedAt`, `finishedAt` | Execution start and finish times, when available |

Mutating a snapshot does not change the stored job. Snapshot creation uses
structured cloning: contexts, properties, results, and error causes must be
cloneable. Unsupported values such as functions cause lookup to throw
`DataCloneError`. Custom class prototypes and custom Error fields are not preserved.

Context and result objects, and nested metadata values, may be shared with the
engine internally. Do not mutate those original objects after submission or
completion.

### `onIdle(): Promise<void>`

Resolves when no queued or active jobs remain. It resolves immediately if the
engine is already idle, supports multiple callers, and works across repeated
rounds of submissions.

Failed jobs also count as finished. `onIdle()` does not reject because a handler
failed; inspect job snapshots for outcomes. New jobs may be submitted after idle
is reached.

## Error handling

Submission and registration errors are thrown synchronously. Both exported error
classes expose a `jobType` field:

- `HandlerAlreadyRegisteredError`: the type already has a handler.
- `HandlerNotRegisteredError`: no handler exists for the submitted type.

Handler exceptions and rejected promises mark the job as `failed`. They release
its slot so other jobs can continue. Non-Error thrown values are wrapped in an
`Error` with the original value available as `cause`.

```js
const engine = new HivePulse();
engine.register('example', () => {
  throw new Error('Unable to complete the job');
});

const id = engine.add({ type: 'example', context: null });
await engine.onIdle();

const job = engine.getJob(id);
if (job?.status === 'failed') {
  console.error(job.error?.message);
}
```

## Scope and limitations

- Jobs run on the same Node.js event loop. Concurrency allows asynchronous work
  to overlap; it does not provide CPU parallelism. Periodic scheduler yields reduce
  scheduler-induced starvation but cannot prevent a handler or application code
  from blocking the event loop. Use worker threads or separate processes for
  CPU-heavy work.
- All jobs, including completed and failed jobs, remain in memory for the
  engine's lifetime. There is no automatic cleanup or persistence.
- Lookup is by ID. Filtering and `getJobs()` are outside v0.1.0.
- Retries, cancellation, priorities, delayed jobs, and recurring jobs are not supported.
- Distributed workers, worker threads, Redis, databases, and HTTP APIs are not included.

## Development

```sh
npm ci
npm run check
```

| Command | Purpose |
| --- | --- |
| `npm run check` | Run type checking, build, and tests |
| `npm run build` | Generate ESM output and declarations in `dist/` |
| `npm run typecheck` | Check source, tests, and configuration |
| `npm test` | Run the Vitest suite |
| `npm run test:watch` | Run tests in watch mode |
| `npm run clean` | Remove generated build output |

## License

[MIT](LICENSE) © 2026 Susanna Avetisyan.
