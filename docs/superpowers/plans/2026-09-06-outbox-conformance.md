# Outbox Store Conformance Kit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish and verify a deterministic runner-agnostic conformance suite for `better-effect-mq-outbox`.

**Architecture:** Keep the kit in `src/testing/conformance.ts` as a consumer-facing scenario list. It will construct validated records, execute the existing append/lease/settlement/inspection protocol, and expose no database, publisher, Runtime, transaction, or `unknown` handle abstraction.

**Tech Stack:** TypeScript 7.x, Bun 1.4.2, `bun:test`, `better-result`, the existing `OutboxStore` and `MemoryOutboxStore` APIs, Oxfmt/Oxlint/tsdown.

**Spec:** `docs/superpowers/specs/2026-09-06-outbox-conformance-design.md`

## Global Constraints

- Use Bun for package management and tests.
- The public TypeScript peer range starts at 6.0.
- The kit must remain runner-agnostic and independent of database and publisher implementations.
- Do not add `transaction?: unknown`, `handle: unknown`, legacy APIs, or exactly-once semantics.
- Do not alter `OutboxPublisher.ts`, `routing.ts`, or database adapters.
- Use `OutboxStore` as the source of truth for `Result` operations and keep assertions at the conformance boundary.
- Before completion run `bun run check` with `/Users/nitoba/.bun/bin/bun`, plus proportional repository gates.

---

### Task 1: Establish the public conformance contract with failing tests

**Files:**
- Create: `packages/better-effect-mq-outbox/tests/conformance.test.ts`
- Create: `packages/better-effect-mq-outbox/tests/types/testing.types.ts`
- Modify: `packages/better-effect-mq-outbox/src/testing/index.ts`
- Create: `packages/better-effect-mq-outbox/src/testing/conformance.ts`

**Interfaces:**
- Consumes: `OutboxStore`, `OutboxAppendStore`, `OutboxOperation`, `MemoryOutboxStore`, record/failure/identity factories.
- Produces: `outboxStoreContract`, `OutboxStoreContractClock`, `OutboxStoreContractOptions`, `OutboxStoreContractScenario`, `OutboxStoreContractSuite`, and `OutboxStoreContractReport`.

- [ ] **Step 1: Write the failing public API tests**

Add a type test that assigns a suite created with `makeOutboxStore: () => MemoryOutboxStore.make()` and a numeric deterministic clock to `OutboxStoreContractSuite`, and checks scenario fields with `expectTypeOf`. Add a runtime test that imports `outboxStoreContract` from `../src/testing`, creates the suite, and asserts that it returns a non-empty list of `{ id, name, category, run }` values.

- [ ] **Step 2: Run the tests to verify they fail for the missing API**

Run:

```bash
/Users/nitoba/.bun/bin/bun run typecheck
/Users/nitoba/.bun/bin/bun test tests/conformance.test.ts
```

Expected: typecheck/test failure because `outboxStoreContract` and its public types do not exist yet.

- [ ] **Step 3: Implement the minimal typed suite scaffold**

Create the public interfaces and a suite factory that validates the factory/clock boundaries, returns immutable scenario descriptors, and initially exposes the scenario list/report shape used by the tests. Re-export only the function from `src/testing/index.ts` as a runtime export and the interfaces as type exports.

- [ ] **Step 4: Run the focused tests to verify the scaffold passes**

Run:

```bash
/Users/nitoba/.bun/bin/bun run typecheck
/Users/nitoba/.bun/bin/bun test tests/conformance.test.ts
```

Expected: the public API/type tests pass; behavior scenarios may still be added in later tasks.

### Task 2: Add append, claim, fencing, heartbeat, and recovery scenarios

**Files:**
- Modify: `packages/better-effect-mq-outbox/src/testing/conformance.ts`
- Modify: `packages/better-effect-mq-outbox/tests/conformance.test.ts`

**Interfaces:**
- Consumes: the Task 1 suite and public store types.
- Produces: scenarios `append-idempotency`, `claim-ordering-and-fencing`, and `heartbeat-and-recovery`.

- [ ] **Step 1: Write the failing scenario assertions**

Register the suite scenarios with Bun and assert that append reports new/duplicate/conflict outcomes; claims are ordered and stale lease tokens are rejected after a later owner claims; heartbeat moves expiry forward; and recovery returns an expired record to pending with its lease cleared.

- [ ] **Step 2: Run the focused conformance test to verify the new scenarios fail**

Run `/Users/nitoba/.bun/bin/bun test tests/conformance.test.ts`.

Expected: the scenario assertions fail because the scaffold does not yet execute these invariants.

- [ ] **Step 3: Implement the scenario bodies**

Add validated fixture helpers, operation/result assertion helpers, per-scenario clock acquisition, and the append/claim/heartbeat/recovery scenario bodies. Use fresh stores per scenario, absolute times derived from the injected clock, `OutboxId`/`OutboxWorkerId`/`OutboxLeaseToken` factories, and `OutboxLeaseLostError` tag checks for fencing failures.

- [ ] **Step 4: Run the focused conformance test to verify green**

Run `/Users/nitoba/.bun/bin/bun test tests/conformance.test.ts` and confirm all registered scenarios pass.

### Task 3: Add settlement, poison, inspection, redrive, and named-outbox scenarios

**Files:**
- Modify: `packages/better-effect-mq-outbox/src/testing/conformance.ts`
- Modify: `packages/better-effect-mq-outbox/tests/conformance.test.ts`

**Interfaces:**
- Consumes: the Task 2 suite, fixture helpers, and report state.
- Produces: settlement/response-loss, poison failure, inspection/redrive, and named-isolation scenarios plus an accurate report.

- [ ] **Step 1: Write the failing scenario assertions**

Add assertions that `markPublished`, `markRetry`, `markFailed`, and `release` produce their documented states; a repeated publish settlement returns `already-applied`; target-missing/request-invalid failures remain inspectable; retry redrive is not claimable before `runAtMs` and is claimable after it; list filters/counts match state; and named stores do not share records.

- [ ] **Step 2: Run the focused conformance test to verify the new assertions fail**

Run `/Users/nitoba/.bun/bin/bun test tests/conformance.test.ts`.

Expected: the newly registered behavior assertions fail until their scenario bodies are implemented.

- [ ] **Step 3: Implement the remaining scenarios and report tracking**

Use the existing serialized failure shape with `target-missing`, `request-invalid`, and `store-transient`; preserve failed records rather than deleting them; model redrive through the existing `markRetry` protocol; call `makeOutboxStore('contract-named')` for the named scenario; and track executed/passed/failed IDs in an immutable report snapshot without coupling to a runner.

- [ ] **Step 4: Run the focused conformance test to verify green**

Run `/Users/nitoba/.bun/bin/bun test tests/conformance.test.ts` and confirm all scenarios pass and the report has no failed IDs.

### Task 4: Document and update package boundary coverage

**Files:**
- Modify: `packages/better-effect-mq-outbox/tests/package/boundaries.ts`
- Modify: `packages/better-effect-mq-outbox/README.md`

**Interfaces:**
- Consumes: the stable `./testing` export shape from Tasks 1–3.
- Produces: package boundary validation and documented runner integration.

- [ ] **Step 1: Add the failing boundary/documentation expectation**

Update the boundary test expectation to include exactly `MemoryOutboxStore` and `outboxStoreContract` as runtime exports from `dist/testing.mjs`, while keeping the existing package export keys and no-transaction/handle checks.

- [ ] **Step 2: Run the boundary test to verify RED, then rebuild for GREEN**

Run `/Users/nitoba/.bun/bin/bun run test:package-boundaries` against the stale artifact, confirm the expected missing-export failure, then run `/Users/nitoba/.bun/bin/bun run build` followed by `/Users/nitoba/.bun/bin/bun run test:package-boundaries`.

Expected: the first boundary check fails because `dist/testing.mjs` has not been rebuilt; the rebuilt artifact then exposes the new function and the second boundary check passes.

- [ ] **Step 3: Add concise README usage**

Document the `outboxStoreContract` import, a runner loop over `suite`, the injected clock/factory shape, the covered protocol guarantees, and the fact that transactional append remains adapter-specific and delivery is at-least-once.

- [ ] **Step 4: Run focused package checks**

Run:

```bash
/Users/nitoba/.bun/bin/bun run typecheck
/Users/nitoba/.bun/bin/bun test
/Users/nitoba/.bun/bin/bun run format:check
/Users/nitoba/.bun/bin/bun run build
/Users/nitoba/.bun/bin/bun run test:package-boundaries
/Users/nitoba/.bun/bin/bun run publint
/Users/nitoba/.bun/bin/bun run lint
```

Expected: all commands exit 0 with no tracked generated files.

### Task 5: Review, verify, commit, push, and open one PR

**Files:**
- Review all changes in the branch against the design and package instructions.

**Interfaces:**
- Consumes: the completed public kit, tests, docs, and package boundary checks.
- Produces: a verified commit on `codex/issue-84-outbox-conformance` and one PR targeting `main` that references `#84` without `Closes`.

- [ ] **Step 1: Run the complete proportional verification**

Run the package `check` with the required Bun path, then run the repository-level targeted gates for the affected package and inspect `git status`/`git diff --check`:

```bash
/Users/nitoba/.bun/bin/bun run check
/Users/nitoba/.bun/bin/bun run build --filter=better-effect-mq-outbox
/Users/nitoba/.bun/bin/bun run test --filter=better-effect-mq-outbox
/Users/nitoba/.bun/bin/bun run typecheck --filter=better-effect-mq-outbox
git diff --check
git status --short
```

- [ ] **Step 2: Request a read-only code review**

Review the final diff from `8a04431` to `HEAD` for API scope, runner independence, result/error semantics, named store behavior, documentation, and forbidden transaction/handle types. Resolve all Critical/Important findings before commit.

- [ ] **Step 3: Commit the implementation**

Use a focused message such as:

```bash
git add packages/better-effect-mq-outbox docs/superpowers/specs/2026-09-06-outbox-conformance-design.md docs/superpowers/plans/2026-09-06-outbox-conformance.md
git commit -m "feat(mq-outbox): add runner-agnostic conformance kit"
```

- [ ] **Step 4: Push and open one PR**

Push the exact branch and create one PR against `main` with a body that references `#84` without a closing keyword:

```bash
git push -u origin codex/issue-84-outbox-conformance
gh pr create --base main --head codex/issue-84-outbox-conformance --title "feat(mq-outbox): add runner-agnostic conformance kit" --body "Implements the public runner-agnostic OutboxStore conformance kit requested in #84.

- Covers append, leases, fencing, heartbeat/recovery, settlement, poison failures, list/counts/redrive, and named outboxes.
- Adds MemoryOutboxStore conformance tests and usage documentation.
- Keeps transactional append adapter-specific and preserves at-least-once semantics."
```

Expected: one PR URL is returned, targeting `main`, with no merge performed.
