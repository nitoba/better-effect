# OutboxPublisher Layer-first and Explicit Routing

## Goal

Complete the durable outbox publisher core for `better-effect-mq-outbox` without capturing an application Runtime or reintroducing legacy startup APIs.

## Public contract

`OutboxRoutes.make` accepts an explicit target-to-`JobStore` token map. It also accepts an ordered entry list so duplicate targets can be rejected at runtime. The resulting value exposes typed route lookup and read-only entries. Unknown targets produce `OutboxRouteMissingError` diagnostics and never silently discard records.

`OutboxPublisher.service(tag)` returns a Service token with `.layer(factory)`. The factory is resolved by `Layer.scopedGen` in the Runtime root and may yield `OutboxConfig` plus the configured outbox and route store requirements. The publisher receives a `RuntimeExecutor` only to resolve those tokens during layer acquisition; the supervisor retains resolved stores and never captures the application Runtime or request resolver.

## Runtime flow

The supervisor has one bounded claim loop and one heartbeat loop. It claims at most the configured available concurrency, validates each persisted `PreparedEnqueue`, resolves the explicit route, converts the prepared value to the current `EnqueueRequest`, and calls that route's `JobStore.enqueue`. A successful enqueue, including `duplicate: true`, is followed by fenced `markPublished`. Retryable enqueue/store failures use bounded exponential backoff through `markRetry`; permanent, invalid, poison, and exhausted records use `markFailed`. Settlement uncertainty is retried conservatively and otherwise left for fenced recovery.

Claims carry the adapter lease owner and token. Heartbeats run for every admitted record while enqueue or settlement is pending. A lost lease stops local settlement but does not claim exactly-once semantics. Quiesce aborts only new claims; already admitted work continues. Shutdown waits for claim compensation, heartbeat completion, enqueue, and fenced settlement before Layer release can close the root resources.

## Scope and constraints

- Use existing `OutboxRecord`, `PreparedEnqueue`, `OutboxStore`, `JobStore`, `Layer`, `Runtime.executor`, and `ServiceRuntime` primitives.
- Keep implementation package-local and small; do not add a dependency, transaction channel, request handle, Runtime-first API, `startWith`, `use`, or any other legacy API.
- Do not change `packages/better-effect-mq-outbox/src/testing` or add MongoDB integration.
- Preserve at-least-once delivery. Idempotency/duplicate enqueue is the convergence mechanism.
- Public exports, runtime tests, type tests, README documentation, package boundary checks, and the existing package build must remain coherent.

## Verification

Run the package tests, typecheck, lint, format check, build, package boundaries, publint, and repository checks with `/Users/nitoba/.bun/bin/bun`. Review the diff for forbidden API strings and confirm the base worktree remains untouched before pushing one PR against `main` that references `#84` without a closing keyword.
