# Changelog

## 0.1.1 — 2026-11-19

- Reject non-function handlers synchronously without registering their job type.
- Coalesce scheduler requests and yield after 64 job starts so other event-loop
  work can progress. FIFO start order and concurrency limits are preserved;
  available slots can be filled on a later event-loop turn.
- Correct npm installation instructions and explain shared-event-loop limitations.
- Add regression coverage for invalid handlers, scheduling fairness, and handlers
  that submit additional jobs; explicitly include Node.js types for builds.

## 0.1.0 — First Buzz

- Initial in-memory FIFO engine with bounded concurrency, job snapshots,
  failure handling, and idle waiting.
