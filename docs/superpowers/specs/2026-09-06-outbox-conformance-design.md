# Outbox Store Conformance Kit Design

## Goal

Add a public, runner-agnostic conformance kit for the `better-effect-mq-outbox`
post-commit store protocol, so Memory and durable adapters can execute the same
deterministic behavioral scenarios without a database, publisher, Runtime, or
generic transaction handle.

## Scope and API

The package will add `src/testing/conformance.ts` and expose its runtime export
through the existing `./testing` subpath. The central API is:

```ts
const suite = outboxStoreContract({
  makeOutboxStore: (name?: string) => MemoryOutboxStore.make(),
  clock: { now: () => 0, advance: () => undefined }
})
```

`makeOutboxStore` returns `OutboxStore & OutboxAppendStore`, synchronously or
through a `PromiseLike`, and accepts an optional logical name for the named
outbox isolation scenario. `clock` is an injected deterministic source whose
`now()` may return an epoch number or `Date`, with `advance(milliseconds)`;
clock factories are accepted for concurrent runner isolation. An optional,
typed store cleanup hook handles adapters that own resources.

The returned suite is a readonly list of `{ id, name, category, run }` scenarios
and a snapshot report. It does not import or call a test runner. Each scenario
creates an isolated store and uses only public OutboxStore/OutboxAppendStore
operations and the injected clock.

## Scenario coverage

The built-in scenarios cover:

1. append, same-digest duplicate, and different-digest conflict;
2. claim ordering, lease ownership, fencing, and redelivery after expiry;
3. heartbeat extension and stalled recovery;
4. publish/retry/fail/release settlement transitions and lost-response
   idempotency;
5. preserving `target-missing` and `request-invalid` poison failures;
6. list filters, counts, and retry-based redrive;
7. default versus named outbox isolation.

Transactional append commit/rollback remains adapter-specific because the core
protocol intentionally has no generic transaction or `unknown` handle. The kit
does not promise exactly-once behavior; the crash-window behavior is represented
by lease redelivery and idempotent settlement.

## Verification and documentation

The package tests will consume the public suite with Bun's runner against
`MemoryOutboxStore`, asserting that every scenario runs and passes. A type test
will protect the factory, clock, suite, and scenario signatures. The package
boundary test will allow the new `outboxStoreContract` runtime export while
keeping the `./testing` subpath free of unrelated exports. README usage will
show a runner adapter loop and the storage-neutral guarantees.
