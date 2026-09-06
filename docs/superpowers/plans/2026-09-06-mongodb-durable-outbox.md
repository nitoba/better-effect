# MongoDB Durable Outbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the durable MongoDB `OutboxStore` adapter and caller-owned transactional append support to `better-effect-mq-mongodb`.

**Architecture:** Reuse the existing MongoDB client, namespace configuration, and migrator while keeping outbox persistence in its own collection. Use the canonical `better-effect-mq-outbox` default/named token family, a pure adapter-specific `appendIn` boundary over `MongoSession`, and short adapter-owned transactions for post-commit lease/settlement/read operations.

**Tech Stack:** TypeScript 7, Bun 1.4.2, `better-effect`, `better-effect-mq`, `better-effect-mq-outbox`, `better-result`, optional `mongodb` 6.x, `bun:test`, Oxfmt, Oxlint, tsdown, publint, and Testcontainers.

**Spec:** `docs/superpowers/specs/2026-09-06-mongodb-durable-outbox-design.md`

## Global Constraints

- Use `/Users/nitoba/.bun/bin/bun` for package management, tests, and gates.
- Keep `mongodb` optional and never load it for caller-owned `MongoDb` usage.
- Use the canonical `OutboxStore` token from `better-effect-mq-outbox`; do not create a second token family.
- Public transaction boundaries use `MongoSession`, never `transaction?: unknown` or `handle: unknown`.
- `appendIn` never opens, commits, rolls back, releases, or ends the caller transaction.
- Outbox state and leases stay separate from JobStore state and leases.
- Preserve at-least-once semantics; do not claim exactly-once delivery.
- Use `bun:test`; do not introduce another test runner or package manager.

---

### Task 1: Package surface and dependency metadata

**Files:**
- Modify: `packages/better-effect-mq-mongodb/package.json`
- Include: `docs/superpowers/specs/2026-09-06-mongodb-durable-outbox-design.md`
- Include: `docs/superpowers/plans/2026-09-06-mongodb-durable-outbox.md`

**Interfaces:**
- Consumes: the existing `better-effect-mq-outbox` package contract.
- Produces: a package that declares `better-effect-mq-outbox` as a peer and development dependency, with no legacy transaction API.

- [ ] **Step 1: Add dependency and fixture scripts**

Add `better-effect-mq-outbox: ">=0.1.0 <0.2.0"` to `peerDependencies`, `better-effect-mq-outbox: "0.1.0"` to `devDependencies`, and scripts for type tests, package boundaries, and external consumer checks. Keep the existing build, test, lint, format, and publint scripts in `check`.

- [ ] **Step 2: Verify the package manifest**

```bash
/Users/nitoba/.bun/bin/bun install --frozen-lockfile
/Users/nitoba/.bun/bin/bun run publint --cwd packages/better-effect-mq-mongodb
```

Expected: both commands exit successfully.

- [ ] **Step 3: Commit planning and dependency metadata**

```bash
git add docs/superpowers/specs/2026-09-06-mongodb-durable-outbox-design.md docs/superpowers/plans/2026-09-06-mongodb-durable-outbox.md packages/better-effect-mq-mongodb/package.json
git commit -m "docs(mongodb): plan durable outbox adapter"
```

### Task 2: MongoDB outbox collection and migration

**Files:**
- Modify: `packages/better-effect-mq-mongodb/src/collections.ts`
- Modify: `packages/better-effect-mq-mongodb/src/migrator.ts`
- Test: `packages/better-effect-mq-mongodb/tests/migrator.test.ts`

**Interfaces:**
- Consumes: `MongoDb`, `MongoCollection`, existing layout marker and migration lock.
- Produces: `mongoCollections(...).outbox`, layout version 3, validator, and claim/lease/target/list indexes.

- [ ] **Step 1: Write the failing migration test**

Extend the fake database migration suite to assert that migration creates the separate outbox collection, installs an outbox validator, creates outbox indexes, records layout version `3`, and upgrades a v2 marker without rewriting a sentinel job.

- [ ] **Step 2: Run the migration test and verify it fails for the missing layout**

```bash
/Users/nitoba/.bun/bin/bun test packages/better-effect-mq-mongodb/tests/migrator.test.ts
```

Expected: failure because the outbox collection and version 3 are absent.

- [ ] **Step 3: Implement the layout changes**

Add the outbox handle and name, advance `MONGODB_LAYOUT_VERSION` to `3`, define a strict top-level validator for persisted OutboxRecord fields, create the collection during migration, and add indexes for `{ namespace, id }`, pending claim order, active lease expiry, target/state administration, and recent records.

- [ ] **Step 4: Run the migration test and verify green**

```bash
/Users/nitoba/.bun/bin/bun test packages/better-effect-mq-mongodb/tests/migrator.test.ts
```

Expected: all migration tests pass.

- [ ] **Step 5: Commit the layout change**

```bash
git add packages/better-effect-mq-mongodb/src/collections.ts packages/better-effect-mq-mongodb/src/migrator.ts packages/better-effect-mq-mongodb/tests/migrator.test.ts
git commit -m "feat(mongodb): add durable outbox layout"
```

### Task 3: Caller-owned transactional append

**Files:**
- Create: `packages/better-effect-mq-mongodb/src/MongoOutbox.ts`
- Modify: `packages/better-effect-mq-mongodb/src/config.ts` only if the narrow Mongo boundary needs a method type
- Test: `packages/better-effect-mq-mongodb/tests/outbox.test.ts`

**Interfaces:**
- Consumes: `MongoSession`, `MongoCollections.outbox`, `OutboxRecord`, `validateOutboxRecord`, `OutboxConflictError`, and canonical outbox token validation.
- Produces: `MongoOutbox.appendIn(session, record, options?)`, `MongoOutboxAppendOptions`, `MongoOutboxTransaction`, and `MongoOutboxRow`.

- [ ] **Step 1: Write failing append tests**

Use a fake outbox collection that records options. Test that a valid append passes `{ session }`; no transaction ownership method is called; same id/digest returns `duplicate: true`; a different digest returns `OutboxConflictError`; and malformed `PreparedEnqueue` returns `OutboxDefinitionError`.

- [ ] **Step 2: Run the focused test and verify the missing API failure**

```bash
/Users/nitoba/.bun/bin/bun test packages/better-effect-mq-mongodb/tests/outbox.test.ts
```

Expected: failure because `MongoOutbox` is not exported yet.

- [ ] **Step 3: Implement the append boundary**

Validate the initial pending record, derive the stable namespace from the optional default/named token, encode BSON fields, and use `findOneAndUpdate` with `_id`, `$setOnInsert`, `upsert: true`, `returnDocument: 'after'`, `includeResultMetadata: true`, and the caller session. Decode the returned document, compare `requestDigest`, and report duplicate status from the driver metadata.

- [ ] **Step 4: Run the focused tests and verify green**

```bash
/Users/nitoba/.bun/bin/bun test packages/better-effect-mq-mongodb/tests/outbox.test.ts
```

Expected: append tests pass and no caller transaction lifecycle method is invoked.

- [ ] **Step 5: Commit the append implementation**

```bash
git add packages/better-effect-mq-mongodb/src/MongoOutbox.ts packages/better-effect-mq-mongodb/src/config.ts packages/better-effect-mq-mongodb/tests/outbox.test.ts
git commit -m "feat(mongodb): add transactional outbox append"
```

### Task 4: Layer-first outbox store operations

**Files:**
- Create: `packages/better-effect-mq-mongodb/src/MongoOutboxStore.ts`
- Modify: `packages/better-effect-mq-mongodb/src/config.ts` only if required by the driver boundary
- Test: `packages/better-effect-mq-mongodb/tests/outbox.test.ts`

**Interfaces:**
- Consumes: `OutboxStore`, `OutboxAppendStore`, canonical token types, `MongoJobStoreClient`, Mongo outbox encoding, and `Layer`/`ServiceContract`.
- Produces: `MongoOutboxStore.layer`, `.layerFor`, `.layerFromConfig`, `.layerFromConfigFor`, and `MongoOutboxStoreContract`.

- [ ] **Step 1: Extend the unit suite with store behavior**

Add tests for default/named Layer resolution, claim order, lease fencing, heartbeat, stale settlement rejection, already-applied publication, retry, failed settlement, release, stalled recovery, `get`, filtered `list`, and `counts`.

- [ ] **Step 2: Run the store tests and verify missing behavior**

```bash
/Users/nitoba/.bun/bin/bun test packages/better-effect-mq-mongodb/tests/outbox.test.ts
```

Expected: failures for the missing `MongoOutboxStore` implementation.

- [ ] **Step 3: Implement validation and adapter-owned transaction helpers**

Reuse the outbox validators for claim, lease, timestamp, state, and serialized failure inputs. Add a short helper that starts a session from `MongoJobStoreClient`, uses snapshot/majority transaction options, preserves tagged outbox errors, redacts driver failures, and always ends the session.

- [ ] **Step 4: Implement claim and recovery**

Inside one adapter-owned transaction, recover expired active records with conditional `findOneAndUpdate`, then repeatedly claim pending due records with deterministic sort, a fresh lease token, owner, expiry, and `$inc` on attempts. Decode every returned document and preserve the active lease invariant.

- [ ] **Step 5: Implement heartbeat and settlement fencing**

Use filters containing namespace/id, active state, exact lease token, and `leaseExpiresAtMs: { $gt: nowMs }`. Treat published records as `already-applied`; clear lease fields on publish/retry/fail/release; preserve failure on release; and return the decoded updated record.

- [ ] **Step 6: Implement reads and Layer lifecycle**

Implement validated `get`, `list`, and `counts`. Acquire through `MongoJobStoreClient.fromDb`/`fromConfig`, verify topology and layout, provide `OutboxStore.of` through the canonical token, isolate named namespaces, and dispose only owned client resources in the Layer finalizer.

- [ ] **Step 7: Run focused tests and typecheck**

```bash
/Users/nitoba/.bun/bin/bun test packages/better-effect-mq-mongodb/tests/outbox.test.ts
/Users/nitoba/.bun/bin/bun run typecheck --cwd packages/better-effect-mq-mongodb
```

Expected: focused tests pass and TypeScript reports no errors.

- [ ] **Step 8: Commit the store implementation**

```bash
git add packages/better-effect-mq-mongodb/src/MongoOutboxStore.ts packages/better-effect-mq-mongodb/src/config.ts packages/better-effect-mq-mongodb/tests/outbox.test.ts
git commit -m "feat(mongodb): implement durable outbox store"
```

### Task 5: Public exports, declaration coverage, consumer, and docs

**Files:**
- Modify: `packages/better-effect-mq-mongodb/src/index.ts`
- Create: `packages/better-effect-mq-mongodb/tests/types/outbox.types.ts`
- Create: `packages/better-effect-mq-mongodb/tests/package/boundaries.ts`
- Create: `packages/better-effect-mq-mongodb/tests/package/external-consumer.ts`
- Create: `packages/better-effect-mq-mongodb/tests/package/consumer/package.json`
- Create: `packages/better-effect-mq-mongodb/tests/package/consumer/tsconfig.json`
- Create: `packages/better-effect-mq-mongodb/tests/package/consumer/src/index.ts`
- Create: `packages/better-effect-mq-mongodb/tests/package/consumer/smoke.mjs`
- Modify: `packages/better-effect-mq-mongodb/README.md`
- Modify: `packages/better-effect-mq-mongodb/CHANGELOG.md`

**Interfaces:**
- Consumes: the Mongo outbox implementation and core outbox token types.
- Produces: consumer-visible exports and compile-time proof of precise default/named Layer environments.

- [ ] **Step 1: Write type and consumer fixtures**

Assert that the default layer provides `InstanceType<typeof OutboxStore>`, a named layer provides the named instance, `appendIn` accepts `MongoSession` rather than an unknown handle, and the packed consumer imports the adapter with `mongodb` still optional.

- [ ] **Step 2: Run fixtures and verify missing export failures**

```bash
/Users/nitoba/.bun/bin/bun run test:types --cwd packages/better-effect-mq-mongodb
/Users/nitoba/.bun/bin/bun run test:package-boundaries --cwd packages/better-effect-mq-mongodb
/Users/nitoba/.bun/bin/bun run test:package-consumer --cwd packages/better-effect-mq-mongodb
```

Expected: failures identify the missing exports and fixture files before wiring.

- [ ] **Step 3: Add exports and package checks**

Export `MongoOutbox`, `MongoOutboxStore`, public adapter types, and the canonical `OutboxStore`/guard/tag. Pack core, MQ, outbox, and Mongo packages; typecheck the consumer under NodeNext; execute it with Node and Bun; and verify the migration marker reaches v3.

- [ ] **Step 4: Update README and changelog**

Document `appendIn` transaction ownership, a `MongoClient.startSession()` example, Layer-first default/named stores, migration v3, separate collection, fencing/recovery, and at-least-once delivery. Do not document publisher or exactly-once support.

- [ ] **Step 5: Run type, consumer, and formatting checks**

```bash
/Users/nitoba/.bun/bin/bun run test:types --cwd packages/better-effect-mq-mongodb
/Users/nitoba/.bun/bin/bun run test:package-boundaries --cwd packages/better-effect-mq-mongodb
/Users/nitoba/.bun/bin/bun run test:package-consumer --cwd packages/better-effect-mq-mongodb
/Users/nitoba/.bun/bin/bun run format:check --cwd packages/better-effect-mq-mongodb
```

Expected: all commands exit successfully.

- [ ] **Step 6: Commit the public surface**

```bash
git add packages/better-effect-mq-mongodb/src/index.ts packages/better-effect-mq-mongodb/tests packages/better-effect-mq-mongodb/README.md packages/better-effect-mq-mongodb/CHANGELOG.md
git commit -m "feat(mongodb): expose durable outbox adapter"
```

### Task 6: MongoDB integration and container gate

**Files:**
- Create: `packages/better-effect-mq-mongodb/tests/integration/outbox.test.ts`
- Modify: `scripts/test-mq-containers.ts`

**Interfaces:**
- Consumes: `MONGODB_URL`, `MONGODB_DATABASE`, `MongoClient`, `MongoOutbox`, `MongoOutboxStore`, and migration.
- Produces: replica-set integration evidence and shared container-gate coverage.

- [ ] **Step 1: Write the conditional integration suite**

Use `test.skip` when `MONGODB_URL` is absent. Cover committed and rolled-back caller transactions, duplicate/conflict behavior, fencing across workers, heartbeat, stalled recovery, settlement states, list/counts, named stores, and migration-created outbox indexes.

- [ ] **Step 2: Run without MongoDB and verify skips**

```bash
/Users/nitoba/.bun/bin/bun test packages/better-effect-mq-mongodb/tests/integration/outbox.test.ts
```

Expected: no failure when `MONGODB_URL` is absent; integration scenarios are skipped.

- [ ] **Step 3: Add the suite to the shared container gate**

Append the integration path to `storageIntegrationTests` in `scripts/test-mq-containers.ts` so the existing pinned Mongo replica-set lifecycle runs the new scenarios.

- [ ] **Step 4: Run MongoDB-backed integration when available**

```bash
MONGODB_URL="$MONGODB_URL" MONGODB_DATABASE="$MONGODB_DATABASE" /Users/nitoba/.bun/bin/bun test packages/better-effect-mq-mongodb/tests/integration/outbox.test.ts
```

Expected: all MongoDB outbox scenarios pass on a replica set; if no URL exists, record the skip in the final report.

- [ ] **Step 5: Commit integration coverage**

```bash
git add packages/better-effect-mq-mongodb/tests/integration/outbox.test.ts scripts/test-mq-containers.ts
git commit -m "test(mongodb): cover durable outbox integration"
```

### Task 7: Verification, review, push, and one PR

**Files:**
- Modify only files required by verification or review findings.

**Interfaces:**
- Consumes: all implementation, test, package, migration, and documentation changes.
- Produces: verified branch `codex/issue-84-mongodb-outbox` and one PR targeting `main` with `Refs #84` and no automatic closing keyword.

- [ ] **Step 1: Run proportional package gates**

```bash
cd packages/better-effect-mq-mongodb
/Users/nitoba/.bun/bin/bun run check
/Users/nitoba/.bun/bin/bun run test:types
/Users/nitoba/.bun/bin/bun run test:package-boundaries
/Users/nitoba/.bun/bin/bun run test:package-consumer
```

Expected: typecheck, tests, format check, build, publint, lint, boundaries, and consumer checks exit successfully. Run MongoDB integration/container coverage separately when Docker/Podman is available.

- [ ] **Step 2: Run repository-level checks for the changed package**

```bash
cd /Users/nitoba/.codex/worktrees/8154/better-effect
/Users/nitoba/.bun/bin/bun run build --filter=better-effect-mq-mongodb
/Users/nitoba/.bun/bin/bun run publint --filter=better-effect-mq-mongodb
/Users/nitoba/.bun/bin/bun run lint --filter=better-effect-mq-mongodb
git diff --check
git status --short
```

Expected: commands succeed, `git diff --check` is empty, and only intended files are modified.

- [ ] **Step 3: Request and address code review**

Request review against `origin/main` and the final branch commit. Resolve all critical and important findings, then rerun affected tests and the proportional gates.

- [ ] **Step 4: Push the branch**

```bash
git push --set-upstream origin codex/issue-84-mongodb-outbox
```

Expected: the requested branch is published without modifying `main`.

- [ ] **Step 5: Open one PR against `main`**

```bash
gh pr create --base main --head codex/issue-84-mongodb-outbox --title "feat(mongodb): add durable outbox adapter" --body $'Implements the MongoDB durable outbox adapter from #84.\n\n- Adds caller-owned transactional append with MongoSession.\n- Adds Layer-first default/named OutboxStore support.\n- Adds collection, layout v3 migration, indexes, leases, fencing, recovery, and package coverage.\n\nRefs #84'
```

Expected: one open PR is returned, targeting `main`, with `Refs #84` and no `Closes`/`Fixes`/`Resolves` directive.
