# better-effect-mq examples

These examples use the public `Queue`, `Job`, `JobStore`, `Flow`, `Runtime`,
`Worker`, and `MemoryJobStore` APIs. They run locally without a database server;
adapter-specific Layers are covered by the [composition guide](../docs/composition.md).

Run the existing examples with:

```bash
bun run typecheck:examples
bun run test:examples
```

The examples are intentionally small and build on the same core model:

- The examples that use `Codec.json` keep their payloads plain JSON so the
  queue and worker composition stays visible. For untrusted inputs, start with
  the schema-backed Zod 4 example below.
- [`producer-only`](./producer-only/main.ts) defines and enqueues an idempotent
  Job without starting a Worker.
- [`worker`](./worker/main.ts) reuses the Job definition and owns a Worker
  through a Layer-first Service.
- [`testing`](./testing/main.ts) uses `TestRuntime`, test clock/ID services,
  and `TestJobStore` to exercise retries without real sleeps.
- [`composition`](./composition/main.ts) provides `JobStore` and
  `JobEventStore` together and waits for a result with an event wake-up plus a
  bounded polling fallback.
- [`flow`](./flow/main.ts) defines a parent Flow with two child Jobs, composes
  the `JobStore` and `FlowStore` persistence providers, runs the handlers, and
  awaits the collected parent result.

For application-facing runtime validation, see the package README's
[schema-backed Zod 4 example](../README.md#quick-start-a-schema-backed-in-memory-queue)
and the runnable [`better-effect-schema` MQ example](../../better-effect-schema/examples/mq-codec.ts).

The complete Flow walkthrough is in the [package README](../README.md#flow-coordinate-a-parent-execution).
For a record-first database handoff, prepare the request, call the adapter's
transaction helper, and let it append the record and own transaction cleanup
before publishing into the same core Job/Worker model. See the [outbox
extension's PostgreSQL example](../../better-effect-mq-outbox/README.md#end-to-end-example-with-postgresql).
