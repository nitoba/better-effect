# Effect.forkScoped Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `Effect.forkScoped` as a small, supervised child-task primitive owned by the current Scope.

**Architecture:** Add a focused task module for the public handle and task state machine, backed by an internal Runtime task supervisor that associates active task records with Runtime Scopes. Add an internal Scope pre-finalizer phase so supervised tasks are interrupted and awaited before ordinary child cleanup and parent resource release; reuse `runScoped`, existing context storage, signal linking, and Runtime outcome classification.

**Tech Stack:** TypeScript, Bun, `bun:test`, `better-result`, existing RuntimeContext/Scope/RuntimeObserver infrastructure.

**Spec:** `docs/superpowers/specs/2026-09-05-effect-fork-scoped-design.md`

## Global Constraints

- Use Bun for package management and tests.
- Keep `Effect` as a type-only facade over `better-result`; do not add a lazy instruction tree, Fiber scheduler, Context, or Runtime child.
- Preserve typed Service requirements and reject non-nominal Promise callbacks at the public boundary.
- Keep DI adapters and container-specific identifiers out of the core task implementation.
- Preserve child-first/LIFO Scope cleanup and Runtime graceful-disposal ordering.
- Do not add legacy aliases, deprecated shims, daemon tasks, detached tasks, cancellation timeouts, or collection scheduler changes.
- Run focused tests while implementing and `bun run check` before completion.

---

### Task 1: Scope-owned task lifecycle and public types

**Files:**
- Create: `packages/better-effect/src/effect/task.ts`
- Create: `packages/better-effect/src/runtime/task.ts`
- Modify: `packages/better-effect/src/scope/internal.ts`
- Modify: `packages/better-effect/src/scope/scope.ts`
- Modify: `packages/better-effect/src/effect/types.ts`
- Modify: `packages/better-effect/src/effect/effect.ts`
- Modify: `packages/better-effect/src/effect/index.ts`
- Modify: `packages/better-effect/src/runtime/context.ts`
- Modify: `packages/better-effect/src/runtime/index.ts`

**Interfaces:**
- `Effect.forkScoped<A, E, R extends AnyService>(program: Program<A, E, R>): Effect<ScopedTask<A, E>, never, R>`.
- `ScopedTask<A, E>` exposes `state`, `await`, `awaitExit`, and `interrupt` only.
- Internal Runtime task supervision binds Runtime-owned Scopes to a task registry and accepts task lifecycle callbacks from `RuntimeHandleImpl`.
- Internal Scope registration accepts a pre-finalizer and runs it before attached children while retaining the public Scope API.

- [ ] **Step 1: Add the focused runtime and type test skeletons for the public task contract.**
- [ ] **Step 2: Run the focused tests and typecheck to confirm the new API is absent or fails for the intended reason.**
- [ ] **Step 3: Implement the public handle, nominal Program boundary, task exit types, signal/context propagation, internal Scope pre-finalizer, and task supervisor.**
- [ ] **Step 4: Run the focused tests and type tests; fix only implementation or contract errors.**
- [ ] **Step 5: Commit the task primitive and scope support.**

### Task 2: Runtime ownership, inspection, and observer lineage

**Files:**
- Modify: `packages/better-effect/src/layer/runtime.ts`
- Modify: `packages/better-effect/src/runtime/types.ts`
- Modify: `packages/better-effect/src/runtime/observer.ts`
- Modify: `packages/better-effect/src/testing/recorded-runtime-observer.ts`
- Modify: `packages/better-effect/src/testing/index.ts`
- Modify: `packages/better-effect/src/opentelemetry/index.ts` only if required by the new observer contract
- Modify: `packages/better-effect/tests/runtime-inspection.test.ts`
- Modify: `packages/better-effect/tests/runtime-observer.test.ts`

**Interfaces:**
- Runtime inspection reports immutable active task views with `taskId`, `parentExecutionId`, optional name, and running state.
- RuntimeObserver reports immutable task start/end metadata with explicit task lineage and terminal state.
- RuntimeHandle binds its root and execution Scopes to one task supervisor, allocates task IDs from existing execution dependencies, and routes cleanup diagnostics through existing best-effort observers.

- [ ] **Step 1: Extend inspection and observer tests with active task and parent-lineage assertions.**
- [ ] **Step 2: Run those focused tests to verify they fail before Runtime integration.**
- [ ] **Step 3: Bind the supervisor in root/request execution contexts and publish task inspection/events without creating execution start/end pairs.**
- [ ] **Step 4: Run runtime inspection/observer tests and existing Runtime tests.**
- [ ] **Step 5: Commit Runtime integration.**

### Task 3: Documentation, package contracts, and end-to-end acceptance

**Files:**
- Create: `packages/better-effect/tests/effect-fork-scoped.test.ts`
- Create: `packages/better-effect/tests/types/effect-fork-scoped.types.ts`
- Modify: `packages/better-effect/tests/types/runtime.types.ts`
- Modify: `packages/better-effect/tests/types/testing.types.ts`
- Modify: `packages/better-effect/tests/runtime-executor.test.ts` or add a focused Runtime integration test where the context contract belongs
- Modify: `packages/better-effect/README.md`
- Modify: `packages/better-effect/src/index.ts` if public root exports need updating
- Modify: `packages/better-effect/package.json` only if package declarations require a subpath adjustment

**Interfaces:**
- Tests demonstrate the outbox-style loop: cycles run, root close interrupts the loop, no new cycles begin, and the loop's Service releases after task settlement.
- Public package imports expose the chosen task types and operation with readable declarations and no deprecated aliases.

- [ ] **Step 1: Add the remaining focused runtime/type cases from issue #147, including explicit storage and concurrent tasks.**
- [ ] **Step 2: Run focused Bun tests and package type contracts.**
- [ ] **Step 3: Update README usage and public export checks.**
- [ ] **Step 4: Run `bun run check` and inspect the complete diff.**
- [ ] **Step 5: Commit documentation and acceptance coverage.**

### Task 4: Review, push, and PR

**Files:**
- No source changes unless review identifies a concrete defect.

- [ ] **Step 1: Run the full verification suite and confirm the worktree diff is intentional.**
- [ ] **Step 2: Request a code review when the environment exposes a reviewer agent; address Critical/Important findings.**
- [ ] **Step 3: Push `codex/issue-147-fork-scoped` to `origin`.**
- [ ] **Step 4: Open one PR against `main` with `Closes #147`; do not merge it.**
