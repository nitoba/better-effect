# better-effect-mq examples

These examples use the real `Job`, `Runtime`, `MemoryJobStore`, `Worker`, and
`TestJobStore` APIs. They are intentionally local and use no database adapter.

```bash
bun run typecheck:examples
bun run test:examples
```

- `producer-only` enqueues an idempotent Job without starting a Worker.
- `worker` reuses the shared Job definition and owns the real Worker through a
  Layer-first Service.
- `testing` uses `TestRuntime`, `ClockTest`, `IdGeneratorTest`, and
  `TestJobStore` to assert an attempt ledger without real sleeps.
