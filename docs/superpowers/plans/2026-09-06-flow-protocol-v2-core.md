# Flow Protocol v2 Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit JSON-neutral flow protocol v2 core and a coherent in-memory reference while preserving every v1 JobStore API and semantic.

**Architecture:** Keep v1 protocol/types, JobRecord, JobStore.Contract, and MemoryJobStore unchanged. Add a protocol-v2 DTO/validation module, a pure Flow descriptor module, and a flow-only `FlowStoreV2` contract implemented by `MemoryFlowStore` with synchronous parent/manifest/dependency atomic sections.

**Tech Stack:** TypeScript 7, Bun 1.4.2, `bun:test`, `better-result`, existing branded protocol validators, Oxfmt, Oxlint, and the existing package export structure.

**Spec:** `docs/superpowers/specs/2026-09-06-flow-protocol-v2-design.md`

## Global Constraints

- Preserve `protocolVersion = 1` and all v1 JobStore/MemoryJobStore behavior.
- Use `protocolVersionV2 = 2` with independent `layoutVersion` and `migration` metadata.
- Keep protocol values JSON-neutral and validate untrusted DTOs before persistence.
- Enforce default/hard max children and depth limits, global child-key uniqueness, and deterministic non-ambiguous IDs.
- Do not add FlowRuntime, a parallel container, Worker.start/startWith/use, an internal Runtime, Effect Stream, or PostgreSQL/Redis/Worker supervisor code.
- Use existing Job definitions/preparation; do not duplicate producer or Job logic in Flow.
- Use `better-result` and `JobDefinitionError`; every Result generator rule in the repository remains unchanged.
- Use `/Users/nitoba/.bun/bin/bun` for install, tests, typecheck, lint, formatting, build, and package gates.

### Task 1: Add protocol-v2 DTOs and validators

**Files:**
- Create: `packages/better-effect-mq/src/protocol/v2.ts`
- Modify: `packages/better-effect-mq/src/protocol/index.ts`
- Modify: `packages/better-effect-mq/src/index.ts`
- Test: `packages/better-effect-mq/tests/flow-v2.test.ts`
- Test: `packages/better-effect-mq/tests/types/flow-v2.types.ts`

**Interfaces:**
- Consumes: v1 `JsonValue`, branded `JobId`, `SerializedJobFailure`, `PreparedEnqueue`, and existing validation helpers.
- Produces: `protocolVersionV2`, `ProtocolVersionV2`, `JobStateV2`, `ParentEnvelope`, `FlowState`, `FlowChildSpec`, `FlowChildRecord`, `FlowChildReport`, `FlowOutboxEntry`, `FanOutOutcome`, `SettlementOutcomeV2`, `FlowLimits`, limit constants, `makeFlowChildId`, and validator functions.

- [ ] **Step 1: Write failing runtime assertions for v2 state, DTO validation, limits, duplicate keys, and deterministic IDs.** Assert v1 `protocolVersion` is still `1`, `waiting-children` is accepted only by v2 validators, unsafe/accessor DTO fields fail, a duplicate child key fails, and two distinct length-prefixed triples produce distinct IDs.
- [ ] **Step 2: Run the focused test to verify it fails for missing v2 exports.**

  Run: `/Users/nitoba/.bun/bin/bun test packages/better-effect-mq/tests/flow-v2.test.ts`

  Expected: FAIL because the v2 module and exports do not exist.
- [ ] **Step 3: Implement the v2 types, explicit version/layout/migration metadata, canonical child-ID encoding, and validators.** Keep `protocol/types.ts` v1-only; use `PreparedEnqueue` as a type-only reference and localize unsafe casts to validated DTO boundaries.
- [ ] **Step 4: Add exact type assertions for v2 unions, FlowState counters, and `SettlementOutcomeV2`.** Include compile-time rejection for non-positive limits and ensure `JobState` remains the v1 union.
- [ ] **Step 5: Run focused runtime and type tests.**

  Run: `/Users/nitoba/.bun/bin/bun test packages/better-effect-mq/tests/flow-v2.test.ts && /Users/nitoba/.bun/bin/bun run --cwd packages/better-effect-mq test:types`

  Expected: PASS.
- [ ] **Step 6: Commit the protocol slice.**

  Run: `git add packages/better-effect-mq/src/protocol packages/better-effect-mq/src/index.ts packages/better-effect-mq/tests/flow-v2.test.ts packages/better-effect-mq/tests/types/flow-v2.types.ts && git commit -m "feat(mq): define flow protocol v2 contracts"`

### Task 2: Add the pure Flow.define and Flow.children surface

**Files:**
- Create: `packages/better-effect-mq/src/flow.ts`
- Modify: `packages/better-effect-mq/src/index.ts`
- Test: `packages/better-effect-mq/tests/flow-v2.test.ts`
- Test: `packages/better-effect-mq/tests/types/flow-v2.types.ts`
- Modify: `packages/better-effect-mq/README.md`

**Interfaces:**
- Consumes: `AnyJobDefinition`, `Job.PayloadInput`, v2 limit validation, and `JobDefinitionError`.
- Produces: `Flow`, `FlowDefinition`, `FlowChildInput`, `FlowChildOptions`, `FlowChildGroup`, and type aliases for parent/child/policy/limits.

- [ ] **Step 1: Add failing tests for immutable descriptors and precise payload inference.** Verify `Flow.define` freezes a descriptor, preserves parent and child tuple types, `Flow.children` preserves each Job payload input, rejects empty/duplicate definition identities and invalid options, and never calls a Job operation.
- [ ] **Step 2: Run the focused runtime/type tests and confirm the new API fails before implementation.**
- [ ] **Step 3: Implement `Flow.define` and `Flow.children` as pure validated data constructors.** Accept finite readonly arrays only, validate options without encoding payloads, and do not resolve Services or capture Runtime.
- [ ] **Step 4: Re-run the focused tests and format the changed files.**

  Run: `/Users/nitoba/.bun/bin/bun test packages/better-effect-mq/tests/flow-v2.test.ts && /Users/nitoba/.bun/bin/bun run --cwd packages/better-effect-mq test:types && /Users/nitoba/.bun/bin/bun run --cwd packages/better-effect-mq format:check`

- [ ] **Step 5: Commit the pure Flow surface.**

  Run: `git add packages/better-effect-mq/src/flow.ts packages/better-effect-mq/src/index.ts packages/better-effect-mq/README.md packages/better-effect-mq/tests/flow-v2.test.ts packages/better-effect-mq/tests/types/flow-v2.types.ts && git commit -m "feat(mq): add pure flow descriptors"`

### Task 3: Define the FlowStoreV2 contract and explicit migration descriptor

**Files:**
- Create: `packages/better-effect-mq/src/store/flow-v2.ts`
- Modify: `packages/better-effect-mq/src/store/index.ts`
- Modify: `packages/better-effect-mq/src/index.ts`
- Modify: `packages/better-effect-mq/src/store/errors.ts`
- Test: `packages/better-effect-mq/tests/types/flow-v2.types.ts`

**Interfaces:**
- Consumes: v2 DTOs and existing `JobStoreOperation` conventions only for naming/shape; no `JobStore.Contract` mutation.
- Produces: `FlowStoreV2Descriptor`, `FlowMigration`, `FlowStoreV2`, `FlowStoreV2Operation`, `FlowFanOutRequest/Result`, `RecordChildResultsRequest/Result`, `CancelFlowRequest/Result`, `FlowReconcileRequest/Result`, `MarkCascadedRequest/Result`, and observation/cascade types.

- [ ] **Step 1: Write failing type tests for the explicit v2 descriptor and operation signatures.** Assert protocol v2 is separate from the v1 `JobStoreDescriptor`, and operation results expose `applied` and `parentSettled` without `transaction?: unknown` or erased handles.
- [ ] **Step 2: Run the package type test and confirm missing contract symbols fail.**
- [ ] **Step 3: Add the flow-only contract and focused error aliases.** Keep the contract synchronous and Result-based so `MemoryFlowStore` has no hidden Runtime or promise scheduler.
- [ ] **Step 4: Run the type tests and package boundary check.**

  Run: `/Users/nitoba/.bun/bin/bun run --cwd packages/better-effect-mq test:types && /Users/nitoba/.bun/bin/bun run --cwd packages/better-effect-mq test:package-boundaries`

- [ ] **Step 5: Commit the v2 contract.**

  Run: `git add packages/better-effect-mq/src/store packages/better-effect-mq/src/index.ts packages/better-effect-mq/tests/types/flow-v2.types.ts && git commit -m "feat(mq): add flow store v2 contract"`

### Task 4: Implement MemoryFlowStore atomic flow state

**Files:**
- Create: `packages/better-effect-mq/src/store/memory-flow.ts`
- Modify: `packages/better-effect-mq/src/store/index.ts`
- Modify: `packages/better-effect-mq/src/index.ts`
- Test: `packages/better-effect-mq/tests/flow-v2.test.ts`
- Test: `packages/better-effect-mq/tests/types/flow-v2.types.ts`

**Interfaces:**
- Consumes: `FlowStoreV2`, v2 validators, `Result`, and deterministic ID helper.
- Produces: `MemoryFlowStore.make()` and a `MemoryFlowStore` implementation with `fanOut`, `recordChildResults`, `cancel`, `reconcile`, `markCascaded`, and detached flow/child inspection methods needed by tests.

- [ ] **Step 1: Add failing runtime tests for atomic FanOut and replay.** Cover complete manifest persistence, `waiting-children`, empty-manifest collect readiness, no partial state on validation failure, same-manifest replay, and conflicting replay rejection.
- [ ] **Step 2: Run those tests and confirm they fail before the Memory implementation.**
- [ ] **Step 3: Implement nested Map storage and one synchronous critical-section boundary.** Store parent snapshot, immutable dependency records, counters, and flow outbox entries together; use canonical dependency keys and clone/validate on every boundary.
- [ ] **Step 4: Add failing tests for `recordChildResults`.** Cover pending-only application, duplicate/late reports, continue completion, fail-fast first failure, fail-fast tie precedence, and remaining-row cancellation.
- [ ] **Step 5: Implement idempotent report application and policy-specific settlement.** Return positional `applied`/`parentSettled`, preserve terminal rows, and make fail-fast win when a batch both fails and exhausts pending rows.
- [ ] **Step 6: Add failing tests for cancellation, cascade acknowledgements, and reconciliation.** Verify cancellation never calls a child store, cascade flags remain false until acknowledgement, missing children return the original deterministic spec, terminal observations synthesize reports, and healthy children remain pending.
- [ ] **Step 7: Implement `cancel`, `markCascaded`, and bounded `reconcile`.** Keep external child enqueue/cancel calls out of the parent atomic section; only durable local state changes occur in Memory.
- [ ] **Step 8: Run all focused runtime/type tests.**

  Run: `/Users/nitoba/.bun/bin/bun test packages/better-effect-mq/tests/flow-v2.test.ts && /Users/nitoba/.bun/bin/bun run --cwd packages/better-effect-mq test:types`

- [ ] **Step 9: Commit the Memory reference.**

  Run: `git add packages/better-effect-mq/src/store/memory-flow.ts packages/better-effect-mq/src/store/index.ts packages/better-effect-mq/src/index.ts packages/better-effect-mq/tests/flow-v2.test.ts packages/better-effect-mq/tests/types/flow-v2.types.ts && git commit -m "feat(mq): add memory flow store reference"`

### Task 5: Document compatibility and add release-facing checks

**Files:**
- Create: `packages/better-effect-mq/docs/protocol/job-store-v2-flows.md`
- Modify: `packages/better-effect-mq/README.md`
- Modify: `packages/better-effect-mq/tests/runtime/entrypoints.test.ts`
- Modify: `packages/better-effect-mq/tests/package/external-consumer.ts`

**Interfaces:**
- Consumes: final exported v2 names and Memory behavior.
- Produces: user-facing protocol/migration guidance and package-boundary coverage proving the new exports are intentional.

- [ ] **Step 1: Add failing export/boundary assertions for the new public names.**
- [ ] **Step 2: Implement the v2 protocol document and README section.** Explain v1 preservation, independent layout/migration, at-least-once reconciliation, and that PostgreSQL/Redis/Worker integration is a later wave.
- [ ] **Step 3: Run runtime entrypoint, package consumer, and format checks.**

  Run: `/Users/nitoba/.bun/bin/bun test packages/better-effect-mq/tests/runtime/entrypoints.test.ts && /Users/nitoba/.bun/bin/bun run --cwd packages/better-effect-mq test:package-consumer && /Users/nitoba/.bun/bin/bun run --cwd packages/better-effect-mq format:check`

- [ ] **Step 4: Commit documentation and public-boundary checks.**

  Run: `git add packages/better-effect-mq/docs packages/better-effect-mq/README.md packages/better-effect-mq/tests/runtime/entrypoints.test.ts packages/better-effect-mq/tests/package/external-consumer.ts && git commit -m "docs(mq): document flow protocol v2 compatibility"`

### Task 6: Verify, review, push, and open one PR

**Files:**
- Modify only files required by verification feedback; no adapter implementation files.

- [ ] **Step 1: Inspect the complete diff and confirm the v1 compatibility checklist.** Check that no prohibited API names or implementation files appear.
- [ ] **Step 2: Run the package gates with the pinned Bun binary.**

  Run: `/Users/nitoba/.bun/bin/bun run --cwd packages/better-effect-mq typecheck && /Users/nitoba/.bun/bin/bun run --cwd packages/better-effect-mq test:types && /Users/nitoba/.bun/bin/bun test packages/better-effect-mq/tests/flow-v2.test.ts && /Users/nitoba/.bun/bin/bun run --cwd packages/better-effect-mq lint && /Users/nitoba/.bun/bin/bun run --cwd packages/better-effect-mq format:check && /Users/nitoba/.bun/bin/bun run --cwd packages/better-effect-mq build && /Users/nitoba/.bun/bin/bun run --cwd packages/better-effect-mq test:package-boundaries && /Users/nitoba/.bun/bin/bun run --cwd packages/better-effect-mq publint`

- [ ] **Step 3: Run the repository boundary checks proportional to the touched package.**

  Run: `/Users/nitoba/.bun/bin/bun run typecheck --filter=better-effect-mq && /Users/nitoba/.bun/bin/bun run lint --filter=better-effect-mq && /Users/nitoba/.bun/bin/bun run format:check --filter=better-effect-mq`

- [ ] **Step 4: Dispatch an independent code review using the final base/head SHAs.** Fix Critical and Important findings, then repeat affected verification commands.
- [ ] **Step 5: Commit any review fixes and verify the worktree is clean except ignored dependencies/build output.**
- [ ] **Step 6: Push the exact branch.**

  Run: `git push -u origin codex/issue-85-protocol-v2-core`

- [ ] **Step 7: Open exactly one PR against `main`, referencing `#85` without `Closes`.**

  Run: `gh pr create --repo nitoba/better-effect --base main --head codex/issue-85-protocol-v2-core --title "feat(mq): add protocol v2 flow core" --body "## Summary\n- add explicit JSON-neutral flow protocol v2 contracts and validation\n- add pure Flow descriptors and MemoryFlowStore reference semantics\n- preserve JobStore protocol v1; PostgreSQL, Redis, and Worker integration remain later waves\n\nReferences #85\n\n## Verification\n- typecheck, focused runtime/type tests, lint, format check, build, package boundaries, and publint"`
