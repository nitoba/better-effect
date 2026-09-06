# OutboxPublisher Layer-first Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit outbox routing and a Layer-first publisher with fenced, retrying, observable delivery and graceful Runtime shutdown behavior.

**Architecture:** `OutboxRoutes` owns an immutable target-to-`JobStore` token map and validates duplicate entry lists. `OutboxPublisher.service(tag).layer(factory)` acquires a supervisor through `Layer.scopedGen`; the supervisor resolves all declared stores once through the provided `RuntimeExecutor`, then owns claim, heartbeat, delivery, retry, and quiesce/drain state without retaining Runtime objects.

**Tech Stack:** TypeScript 7, Bun, `bun:test`, `better-effect`, `better-effect-mq`, `better-result`, Oxfmt/Oxlint, tsdown.

**Spec:** `docs/superpowers/specs/2026-09-06-outbox-publisher-design.md`

## Global Constraints

- Use `/Users/nitoba/.bun/bin/bun` for package management, tests, and release gates.
- Do not edit `main`; all work is on `codex/issue-84-outbox-publisher` from `8a04431`.
- Do not add `transaction?: unknown`, `handle: unknown`, Runtime-first startup, `startWith`, `use`, or MongoDB changes.
- Do not modify `packages/better-effect-mq-outbox/src/testing` or the conformance kit.
- Preserve at-least-once delivery; duplicate enqueue is success and no exactly-once guarantee is claimed.
- Every public API change gets runtime tests, type tests, documentation, and exports before the final `bun run check`.

---

### Task 1: Explicit route registry

**Files:**
- Create: `packages/better-effect-mq-outbox/src/routing.ts`
- Modify: `packages/better-effect-mq-outbox/src/errors.ts`
- Modify: `packages/better-effect-mq-outbox/src/index.ts`
- Test: `packages/better-effect-mq-outbox/tests/routing.test.ts`
- Test: `packages/better-effect-mq-outbox/tests/types/routing.types.ts`

**Interfaces:**
- Consumes: `AnyJobStoreToken` from `better-effect-mq` and `OutboxDefinitionError`.
- Produces: `OutboxRoutes.make(routes)`, `OutboxRoutes.get(target)`, read-only route entries, `OutboxRouteMissingError`, and a route-token type used by the publisher.

- [ ] **Step 1: Write the failing tests**

  Cover object-map lookup, ordered-entry duplicate rejection, invalid/empty targets, unknown-target diagnostics, and exact route-token inference with `expectTypeOf`.

- [ ] **Step 2: Run the routing tests to verify they fail**

  Run: `cd packages/better-effect-mq-outbox && /Users/nitoba/.bun/bin/bun test tests/routing.test.ts`

  Expected: FAIL because the new route export and implementation do not yet exist.

- [ ] **Step 3: Implement the minimal route registry**

  Store validated entries in a private `Map<string, AnyJobStoreToken>`. Support both a literal object map and `readonly { target, store }[]`; reject duplicate entry targets with `OutboxDefinitionError`; return `undefined` for unknown targets so the publisher can create `OutboxRouteMissingError` with the outbox id.

- [ ] **Step 4: Run routing tests and type tests**

  Run the runtime test and the package typecheck. Expected: all route assertions pass and the route map preserves the configured token union.

- [ ] **Step 5: Commit the route slice**

  ```bash
  git add packages/better-effect-mq-outbox/src/routing.ts packages/better-effect-mq-outbox/src/errors.ts packages/better-effect-mq-outbox/src/index.ts packages/better-effect-mq-outbox/tests/routing.test.ts packages/better-effect-mq-outbox/tests/types/routing.types.ts
  git commit -m "feat(outbox): add explicit route registry"
  ```

### Task 2: Publisher service and Layer contract

**Files:**
- Create: `packages/better-effect-mq-outbox/src/OutboxPublisher.ts`
- Modify: `packages/better-effect-mq-outbox/src/index.ts`
- Test: `packages/better-effect-mq-outbox/tests/publisher-layer.test.ts`
- Test: `packages/better-effect-mq-outbox/tests/types/publisher-layer.types.ts`

**Interfaces:**
- Consumes: `OutboxStore` contracts/tokens, `OutboxRoutes`, `Layer.scopedGen`, `Runtime.executor`, and `ServiceRuntime.resolve`.
- Produces: `OutboxPublisher.service(tag)`, `OutboxPublisherConfig`, `OutboxPublisherOptions`, `OutboxPublisherHandle`, and `OutboxPublisherEvent`.

- [ ] **Step 1: Write failing Layer and type tests**

  Assert a publisher layer is lazy until Runtime creation, starts once, exposes the exact publisher Service instance, requires every configured outbox and route JobStore, and does not expose `start`, `startWith`, or a Runtime parameter. Add a Runtime disposal test proving the Layer-owned publisher is released after admitted work settles.

- [ ] **Step 2: Run the tests to verify the contract is absent**

  Run: `cd packages/better-effect-mq-outbox && /Users/nitoba/.bun/bin/bun test tests/publisher-layer.test.ts`

  Expected: FAIL because `OutboxPublisher` is not exported.

- [ ] **Step 3: Add the typed Service/Layer shell**

  Define options/default validation, the publisher Service token factory, requirements derived from outbox tokens and route tokens, and a scoped Layer factory that uses `Runtime.executor` only during acquisition. Return a handle with `quiesce` and `stop`; defer the actual loops to the supervisor implementation in Task 3.

- [ ] **Step 4: Run Layer tests and typecheck**

  Expected: the layer is lazy, starts exactly once, and typed Runtime composition rejects missing store providers.

- [ ] **Step 5: Commit the Service/Layer slice**

  ```bash
  git add packages/better-effect-mq-outbox/src/OutboxPublisher.ts packages/better-effect-mq-outbox/src/index.ts packages/better-effect-mq-outbox/tests/publisher-layer.test.ts packages/better-effect-mq-outbox/tests/types/publisher-layer.types.ts
  git commit -m "feat(outbox): add Layer-first publisher contract"
  ```

### Task 3: Claim, route, enqueue, and fenced settlement

**Files:**
- Modify: `packages/better-effect-mq-outbox/src/OutboxPublisher.ts`
- Test: `packages/better-effect-mq-outbox/tests/publisher.test.ts`

**Interfaces:**
- Consumes: the Service/Layer shell from Task 2 and the existing `MemoryOutboxStore`/fake `JobStore` contracts.
- Produces: the running supervisor flow: claim → `PreparedEnqueue` validation → explicit route lookup → enqueue → fenced settlement.

- [ ] **Step 1: Write failing delivery tests**

  Exercise successful delivery, `duplicate: true` as success, invalid persisted requests as `markFailed`, unknown routes as inspectable route-missing failures, permanent enqueue failures as `markFailed`, and the exact lease token in `heartbeat`/`markPublished`/settlement calls.

- [ ] **Step 2: Run the delivery tests to verify they fail**

  Run: `cd packages/better-effect-mq-outbox && /Users/nitoba/.bun/bin/bun test tests/publisher.test.ts`

  Expected: FAIL because the supervisor has no delivery implementation.

- [ ] **Step 3: Implement the bounded supervisor loop**

  Resolve store tokens once during Layer acquisition. Claim only the remaining concurrency, track admitted records, validate and strip the prepared protocol field into `EnqueueRequest`, treat duplicate enqueue as success, and use the claim lease token for fenced settlement. Normalize Result and rejected operation outcomes without swallowing diagnostics.

- [ ] **Step 4: Run delivery tests and inspect state transitions**

  Expected: published records settle once, duplicate enqueue settles published, poison/permanent records become failed, and route absence remains retryable/inspectable according to attempts.

- [ ] **Step 5: Commit the delivery slice**

  ```bash
  git add packages/better-effect-mq-outbox/src/OutboxPublisher.ts packages/better-effect-mq-outbox/tests/publisher.test.ts
  git commit -m "feat(outbox): publish claimed records through routes"
  ```

### Task 4: Retry, heartbeat, backpressure, and quiesce/drain

**Files:**
- Modify: `packages/better-effect-mq-outbox/src/OutboxPublisher.ts`
- Modify: `packages/better-effect-mq-outbox/tests/publisher.test.ts`
- Create: `packages/better-effect-mq-outbox/tests/publisher-shutdown.test.ts`

**Interfaces:**
- Consumes: supervisor delivery path from Task 3 and all current OutboxStore lease operations.
- Produces: bounded exponential retry/backoff, periodic heartbeat/fencing behavior, concurrency admission, and safe Runtime shutdown.

- [ ] **Step 1: Write failing lifecycle tests**

  Use controllable promises to assert concurrency never exceeds the configured limit, retryable failures call `markRetry` with increasing bounded `runAtMs`, heartbeat runs while enqueue is blocked, lost leases stop local settlement, quiesce stops new claims, and disposal waits for an admitted enqueue and mark operation before store release.

- [ ] **Step 2: Run lifecycle tests to verify they fail**

  Run: `cd packages/better-effect-mq-outbox && /Users/nitoba/.bun/bin/bun test tests/publisher-shutdown.test.ts tests/publisher.test.ts`

  Expected: FAIL on missing retry/heartbeat/drain behavior.

- [ ] **Step 3: Implement lifecycle coordination**

  Keep claim admission bounded, run heartbeat against every active lease, back off retryable store failures with a capped exponential delay, compensate claims returned during quiesce with `release`, and have `stop` await claim cleanup, active delivery, heartbeat, and final settlement before the Layer release returns.

- [ ] **Step 4: Run lifecycle tests and check observer events**

  Expected: no new claims after quiesce, admitted work completes, and observer callbacks receive stable low-cardinality event kinds without changing the primary operation outcome when an observer throws.

- [ ] **Step 5: Commit the lifecycle slice**

  ```bash
  git add packages/better-effect-mq-outbox/src/OutboxPublisher.ts packages/better-effect-mq-outbox/tests/publisher.test.ts packages/better-effect-mq-outbox/tests/publisher-shutdown.test.ts
  git commit -m "feat(outbox): add retry heartbeat and graceful drain"
  ```

### Task 5: Public documentation and package gates

**Files:**
- Modify: `packages/better-effect-mq-outbox/README.md`
- Modify: `packages/better-effect-mq-outbox/CHANGELOG.md`
- Modify: `packages/better-effect-mq-outbox/src/index.ts` only if final export review finds a missing public symbol
- Test: `packages/better-effect-mq-outbox/tests/package/boundaries.ts` only if an export assertion must be extended; do not change conformance source

- [ ] **Step 1: Document the canonical Layer-first setup**

  Show `OutboxRoutes.make`, `OutboxPublisher.service(...).layer(async function* () { ... })`, required route JobStore layers, at-least-once semantics, duplicate success, retry/failed inspection, and Runtime-owned shutdown. State that no Runtime is captured and no exactly-once guarantee is made.

- [ ] **Step 2: Add the package changelog entry**

  Record the new public routing and publisher APIs under the unreleased section without claiming issue closure.

- [ ] **Step 3: Run package gates**

  Run from the package: `/Users/nitoba/.bun/bin/bun run check`. Also scan source for forbidden legacy API patterns and confirm `src/testing` is unchanged.

- [ ] **Step 4: Commit documentation and gate fixes**

  ```bash
  git add packages/better-effect-mq-outbox/README.md packages/better-effect-mq-outbox/CHANGELOG.md packages/better-effect-mq-outbox/src/index.ts packages/better-effect-mq-outbox/tests/package/boundaries.ts
  git commit -m "docs(outbox): document publisher and routing"
  ```

### Task 6: Repository verification, review, push, and PR

- [ ] **Step 1: Run fresh proportional repository validation**

  Run `/Users/nitoba/.bun/bin/bun run check` from the repository root, plus the package test/typecheck/build commands if the root check does not report them independently. Run `git diff --check`, `git status --short`, and inspect `git diff main...HEAD`.

- [ ] **Step 2: Perform a final API and lifecycle review**

  Confirm all public types are exported from the package root, `src/testing` and Mongo adapters are untouched, route tokens are required by the Layer, only the executor is retained for resolution, duplicate is success, fencing uses lease tokens, and Runtime disposal cannot release stores before admitted work settles.

- [ ] **Step 3: Push the branch**

  ```bash
  git push -u origin codex/issue-84-outbox-publisher
  ```

- [ ] **Step 4: Open exactly one PR against `main`**

  Use `gh pr create --base main --head codex/issue-84-outbox-publisher` with a body that references `#84` without `Closes`, `Fixes`, or another closing keyword. Do not merge.

- [ ] **Step 5: Report the final evidence**

  Include changed files, commit SHA, validation commands/results, and the PR URL; explicitly note that `main` was not edited or merged.
