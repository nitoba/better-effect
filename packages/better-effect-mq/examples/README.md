# better-effect-mq examples

These examples use the real `Job`, `Runtime`, `MemoryJobStore`,
`MemoryJobEventStore`, `Worker`, and `TestJobStore` APIs. They are intentionally
local and use no database server. Adapter-specific PostgreSQL and Redis Layer
recipes are kept in the [composition guide](../docs/composition.md) because
those adapters require a host-owned pool/client or their own connection
factory.

```bash
bun run typecheck:examples
bun run test:examples
```

- `producer-only` enqueues an idempotent Job without starting a Worker.
- `worker` reuses the shared Job definition and owns the real Worker through a
  Layer-first Service.
- `testing` uses `TestRuntime`, `ClockTest`, `IdGeneratorTest`, and
  `TestJobStore` to assert an attempt ledger without real sleeps.
- `composition` provides `JobStore` and `JobEventStore` in one Runtime,
  appends committed Memory transitions, and waits for a result through events
  with a bounded polling fallback.
