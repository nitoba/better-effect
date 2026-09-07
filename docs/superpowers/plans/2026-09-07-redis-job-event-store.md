# Redis Job Event Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional durable `JobEventStore` extension to `packages/better-effect-mq-redis`, backed by a Redis Stream per namespace, with atomic event append for supported job and queue transitions, cursor reads, retention, and wake-assisted waiting.

**Architecture:** Preserve the existing Redis JobStore API and behavior by default. Event-enabled JobStore layers opt into event append and compose an associated `JobEventStore` reader layer. Every enabled transition passes the event stream and metadata keys to the existing Lua atomic unit; the script validates the event payload, mutates the state, appends one safe event with `XADD`, and trims retention before returning. The reader uses `XRANGE`/`XREVRANGE`, opaque namespace-bound stream cursors, metadata-based expiration checks, and the existing wake channel only as a hint while polling remains the correctness path.

**Tech Stack:** TypeScript, Bun, `better-result`, `better-effect-mq` JobEventStore contracts, node-redis raw commands, Redis Lua scripts, `bun:test`.

**Spec:** `packages/better-effect-mq/docs/protocol/durable-events-v1.md` and [issue #87](https://github.com/nitoba/better-effect/issues/87)

## Global Constraints

- Keep the extension optional: existing `RedisJobStore.layer` must not create or append an event stream.
- Keep all namespace keys, including event stream and metadata keys, in the same Redis hash slot.
- Append only safe event fields; never include payloads, results, failure details, metadata, or Redis keys.
- Append inside the same Lua script as the relevant transition; do not append from a later callback.
- Preserve Result/Effect semantics and the existing Runtime-first Layer APIs; do not add an Effect Stream abstraction.
- Preserve atomic failures: do not catch or mask `XADD`, `XTRIM`, decoding, or Redis command errors.
- Use `better-effect-mq` as the source of truth for the public `JobEventStore` contract and event types.
- Update runtime tests, type tests, package-boundary coverage, README documentation, and run `bun run check`.

---

## Task 1: Add failing Redis event-store contract and package API tests

**Files:**
- Create: `packages/better-effect-mq-redis/tests/integration/event-store.test.ts`
- Create: `packages/better-effect-mq-redis/tests/types/event-store.types.ts`
- Modify: `packages/better-effect-mq-redis/tests/package/consumer/src/index.ts`
- Modify: `packages/better-effect-mq-redis/src/index.ts` (only the exports needed by the failing type test)

- [ ] Add an integration suite skipped without `REDIS_URL` that provisions an event-enabled Redis JobStore and checks the public reader through the actual Layer API.
- [ ] Cover enqueue, claim, successful settlement, retry scheduling, failure, cancellation request/change semantics, pause/resume idempotency, admin retry/promote, release, stalled recovery, and removal where the Redis store supports each operation.
- [ ] Cover duplicate enqueue and already-applied settlement do not create duplicate events.
- [ ] Cover cursor pagination, exclusive `after`, queue/job/type filters, tail cursor, retention expiration, concurrent writers, and namespace isolation.
- [ ] Cover `awaitEvents` with a matching event, a lost wake notification followed by polling, and abort/disposal failure.
- [ ] Assert event payloads contain only the safe contract fields and no serialized job payload/result/failure/metadata/key material.
- [ ] Add type assertions for default and named associated tokens, event-enabled layer return types, reader options, and opaque cursors.
- [ ] Add a package-consumer import/use case so the built package exposes the new public API.
- [ ] Run the new tests first and confirm they fail because the API/implementation is absent.

## Task 2: Add event encoding and namespace layout support

**Files:**
- Create: `packages/better-effect-mq-redis/src/event-codec.ts`
- Modify: `packages/better-effect-mq-redis/src/layout.ts`
- Modify: `packages/better-effect-mq-redis/src/index.ts`

- [ ] Define the internal event append options and safe transition-event builders without exporting low-level implementation helpers.
- [ ] Map supported operations to the v1 event types, including settlement outcomes and the “only when changed” cancellation-request rule.
- [ ] Add `events` and `eventsMeta` keys to `RedisKeyLayout` using the existing namespaced hash-tag construction.
- [ ] Preserve the base layout version/checksum compatibility for namespaces that do not use events; event keys are an optional extension.
- [ ] Export only the public Redis event-store options/type surface needed by consumers.
- [ ] Add focused tests for event mapping and key-slot equality, then run them red before the implementation is wired into the store.

## Task 3: Implement the Redis Stream reader and wake-assisted waiting

**Files:**
- Create: `packages/better-effect-mq-redis/src/event-store.ts`
- Modify: `packages/better-effect-mq-redis/src/config.ts`
- Modify: `packages/better-effect-mq-redis/src/index.ts`

- [ ] Implement opaque namespace-bound stream cursors with Redis Stream ID validation and `0-0` as the empty tail.
- [ ] Implement `tailCursor`, `read`, and `awaitEvents` against `XRANGE`, `XREVRANGE`, and the event metadata hash.
- [ ] Make reads advance `nextCursor` over examined-but-filtered entries and keep `after` exclusive.
- [ ] Detect trimmed cursors with `JobEventCursorExpiredError` and report the first available cursor when known.
- [ ] Validate limits and filters at the public boundary; preserve the core failure types.
- [ ] Reuse `subscribeWake` only to wake waiters; always re-check the stream and keep bounded polling as the fallback for lost notifications/reconnects.
- [ ] Ensure disposal settles waiters and closes only Redis resources owned by this Layer.
- [ ] Add reader-layer factories for default and associated `JobEventStore` tokens, config objects, and optional client/subscriber ownership.
- [ ] Run the reader unit/integration tests against fake raw command replies where appropriate and against Redis when `REDIS_URL` is available.

## Task 4: Add atomic Lua event append and retention

**Files:**
- Modify: `packages/better-effect-mq-redis/src/scripts/enqueue.lua`
- Modify: `packages/better-effect-mq-redis/src/scripts/enqueue-many.lua`
- Modify: `packages/better-effect-mq-redis/src/scripts/claim.lua`
- Modify: `packages/better-effect-mq-redis/src/scripts/controlled-claim.lua`
- Modify: `packages/better-effect-mq-redis/src/scripts/settle.lua`
- Modify: `packages/better-effect-mq-redis/src/scripts/release.lua`
- Modify: `packages/better-effect-mq-redis/src/scripts/recover-stalled.lua`
- Modify: `packages/better-effect-mq-redis/src/scripts/cancel.lua`
- Modify: `packages/better-effect-mq-redis/src/scripts/promote.lua`
- Modify: `packages/better-effect-mq-redis/src/scripts/retry.lua`
- Modify: `packages/better-effect-mq-redis/src/scripts/remove.lua`
- Modify: `packages/better-effect-mq-redis/src/scripts/pause.lua`
- Modify: `packages/better-effect-mq-redis/src/scripts/resume.lua`

- [ ] Add a local Lua helper to validate safe event input, append one JSON `data` field via `XADD`, maintain stream metadata, and apply count/age retention with `XTRIM`.
- [ ] Validate event stream/meta key types before state mutation and propagate Redis errors directly.
- [ ] Add event keys to the relevant `KEYS` arrays and request bodies while retaining same-slot validation.
- [ ] Append exactly one event only for an applied transition; do not append on duplicate enqueue, no-op pause/resume, unchanged cancellation request, or already-applied settlement.
- [ ] Keep event append and retention in the same script invocation as the state mutation.
- [ ] Add script-level tests or integration assertions proving a forced append failure leaves the transition failed/visible rather than silently succeeding.
- [ ] Rebuild the script manifest/checksum through the existing registry path and ensure existing non-event scripts remain valid.

## Task 5: Integrate event append with Redis JobStore transitions and layers

**Files:**
- Modify: `packages/better-effect-mq-redis/src/store.ts`
- Modify: `packages/better-effect-mq-redis/src/client.ts` (only if command/ownership plumbing is required)
- Modify: `packages/better-effect-mq-redis/src/index.ts`

- [ ] Thread optional event options through the Redis JobStore implementation while leaving ordinary layers unchanged.
- [ ] Build safe events at each transition boundary using the previous/next records and attempt outcome, then pass them into the corresponding Lua body.
- [ ] Cover enqueue-many, claim/controlled claim, settlement, release, retry, cancellation/request, promote, stalled recovery, remove, and pause/resume.
- [ ] Keep event-enabled JobStore and reader Layer composition on one namespace and associated token.
- [ ] Add `RedisJobStore.layerWithEvents`, `layerWithEventsFor`, and config variants returning both the JobStore and associated `JobEventStore` services.
- [ ] Add/retain standalone `RedisJobEventStore` reader layers for an already-enabled namespace.
- [ ] Ensure disposal closes the JobStore root resources and reader resources without double-closing caller-owned clients.
- [ ] Run the Redis integration suite and existing JobStore conformance suite after each transition group.

## Task 6: Documentation and final verification

**Files:**
- Modify: `packages/better-effect-mq-redis/README.md`
- Modify: `packages/better-effect-mq/docs/protocol/durable-events-v1.md` only if Redis-specific behavior needs clarification
- Modify: `packages/better-effect-mq-redis/tests/package/consumer/src/index.ts` if package examples need completion

- [ ] Document event-enabled Layer construction, reader usage, retention, cursor semantics, wake fallback, namespace safety, and safe payload guarantees.
- [ ] State that the extension is opt-in and that the event stream is not an Effect Stream.
- [ ] Run formatting, typechecking, linting, package tests, package build, publint, and `bun run check`.
- [ ] Inspect the final diff and package tarball for accidental exports, workspace references, sensitive fields, or unrelated edits.
- [ ] Commit the completed implementation on `codex/issue-87-redis-job-event-store`.
- [ ] Push the branch and open a PR against `main` with “Part of #87” in the body, never “Closes #87”.
