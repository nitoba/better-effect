# better-effect-schema Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Zod-coupled schema package with a provider-neutral `better-effect-schema` package, optional provider adapters, safe Result/Effect boundaries, and reproducible package verification.

**Architecture:** A small Standard Schema core owns inference, operations, classes, derivations, capabilities, and safe diagnostics. Provider-specific behavior lives in optional subpaths; the root package only depends on `better-result`, `better-effect`, and the Standard Schema type contract. Work proceeds in dependency waves, with a single integration worktree and one child worktree per issue.

**Tech Stack:** TypeScript 7 development compiler (preserving the declared floor), Bun, `bun:test`, `better-result`, `better-effect`, Standard Schema, Zod, Valibot, ArkType, Oxfmt/Oxlint, tsdown and existing release scripts.

**Spec:** `docs/superpowers/specs/2026-09-06-better-effect-schema-migration-design.md`

## Global Constraints

- Use Bun and `bun:test`; do not add Vitest, Jest, npm workspaces, pnpm, or another package manager.
- All fallible package-invoked operations return `Result`/`Effect<A, E, never>` or a Promise of that result; no covered exception or rejection escapes.
- The root package imports no Zod, Valibot, ArkType, provider internals, EffectTS, Runtime, Layer, Scope, MQ, Auth, or Kysely.
- Optional adapters expose only real capabilities and never use a global registry, universal proxy, `_zod`, or permissive fallback schemas.
- `better-result` remains the source of truth for Result, TaggedError, and UnhandledException.
- Public declarations preserve exact Input, Output, Props, Instance, and failure unions; use `expectTypeOf(...).toEqualTypeOf` for equality contracts.
- No npm publication, deprecation, Git tag, GitHub Release, or remote mutation is allowed.
- Keep the old package only as documented migration history; do not publish a compatibility shim.
- Run `bun run check` before the final completion claim, and record any pre-existing or infrastructure-blocked gate with fresh evidence.

## Worktree and integration policy

- Integration branch: `codex/issue-209-schema-migration` in `.worktrees/issue-209`.
- Child branches are named `codex/issue-<number>-schema` and are created from the latest integration commit satisfying their dependencies.
- Every completed child issue becomes its own pull request targeting `main`, with the issue number in the title/body and fresh verification evidence. A child PR is not considered delivered merely because its commit exists in the integration worktree.
- After a child PR is opened, update the integration branch from the reviewed child commit only after the PR is ready; dependent branches are based on the corresponding approved `main` state. Do not merge or close PRs automatically unless the user explicitly asks for that follow-up.
- #210, #211, and #213 are sequential integrator-owned prerequisites.
- #214 and #215 may run in parallel after #213.
- #216 is the convergence point; #217, #220, #221, #222, and #224 may then run in disjoint child worktrees. `src/index.ts`, manifests, lockfiles, workflows, and release routing have one integration owner.
- #218 and #219 follow #217; #223 follows #218.
- #225 and #226 run in parallel after their dependency sets; #227 is final and sequential.
- Merge or cherry-pick only verified child commits into integration. Resolve shared-file conflicts centrally.

## Tasks

### Task 1: #210 — Contract and parity inventory

**Files:** `docs/better-effect-schema-migration.md`, package docs/architecture inventory, public API/test audit.

- [ ] Audit current exports, operations, classes, codecs, derivations, JSON Schema, examples, consumers, and tests.
- [ ] Write the before/after parity matrix with exact signatures, failure behavior, adapter destination, and test evidence.
- [ ] Record ownership for shared barrels, manifests, lockfiles, and adapters.
- [ ] Run the current package baseline tests and record failures without weakening assertions.
- [ ] Commit as `docs(schema): define migration contracts`.

### Task 2: #211 — Structural rename and workspace/build preparation

**Files:** move `packages/better-effect-zod` to `packages/better-effect-schema`; root/package manifests, lockfile, tsconfigs, workflows, release routing, package scripts.

- [ ] Move the package once with `git mv`; update executable references and package metadata.
- [ ] Add Standard Schema types as production-available type dependency and preserve current peer floors.
- [ ] Keep the temporary Zod coupling explicit and release-blocked until adapters land.
- [ ] Validate package discovery, build, typecheck, release dry routing, and absence of empty exports.
- [ ] Commit as `refactor(schema): rename package and establish boundaries`.

### Task 3: #213 — Typed failures and no-throw execution boundaries

**Files:** `src/failure.ts`, `src/schema-effect.ts`, `src/internal/` execution/diagnostic helpers, failure tests and type fixtures.

- [ ] Implement the seven provider-neutral failure classes with stable tags and non-enumerable causes.
- [ ] Normalize Standard Schema issues and safe diagnostics without invoking hostile serialization hooks.
- [ ] Implement sync invocation, async invocation, thenable detection, and observed rejection handling.
- [ ] Add adversarial runtime tests and exact failure type tests.
- [ ] Commit as `feat(schema): add safe typed failures and boundaries`.

### Task 4: #214 — Standard Schema decode

**Files:** `src/standard/`, `src/operations/decode*`, operations/types tests.

- [ ] Implement sync/async data-first and data-last decode overloads over `~standard.validate`.
- [ ] Preserve Input/Output inference and distinguish invalid data, malformed protocol, execution failure, and async-required cases.
- [ ] Ensure each provider callback is invoked once and all Promise rejections are observed.
- [ ] Add hand-written Standard Schema tests for falsy values, undefined/null, nested paths, and typed failures.
- [ ] Commit as `feat(schema): decode Standard Schema values safely`.

### Task 5: #215 — Portable capabilities and local configuration

**Files:** `src/capabilities/`, `src/types/`, `Schema.with` facade, capability tests.

- [ ] Define explicit contracts for fields, props, encoding, projections, construction, derivation, and JSON Schema.
- [ ] Make capability availability type-visible and return `SchemaUnsupportedOperation` when absent.
- [ ] Implement local declarative `Schema.with(adapter)` with no global mutation or provider imports.
- [ ] Add type tests proving unsupported operations do not appear as valid operations.
- [ ] Commit as `feat(schema): define explicit portable capabilities`.

### Task 6: #216 — Explicit codecs, encoding, and projections

**Files:** `src/codecs/`, capability integration, codec/projection tests.

- [ ] Implement explicit field/object codecs and encoded/props projections using #214/#215 contracts.
- [ ] Reject irreversible or unavailable transformations with typed failures; never invert transforms or silently return identity.
- [ ] Preserve defaults, normalizations, optionality, and Input/Output/Props distinctions.
- [ ] Add runtime and type regression coverage for Date/ISO and object-level transforms.
- [ ] Commit as `feat(schema): add explicit codecs and projections`.

### Task 7: #217 — Schema.Class and real construction

**Files:** `src/classes/`, `src/types/`, class runtime/tests and type fixtures.

- [ ] Build declarative class factories usable in `extends`, retaining invalid definitions for `Schema.check`.
- [ ] Implement real instance construction, identity, protected/private fields, methods/getters, inheritance, `make`, `makeAsync`, and `unsafeMake` Result boundaries.
- [ ] Ensure `new` is not presented as the validating public path and constructors/getters/callbacks are safely captured.
- [ ] Add exact Input/Props/Instance/Output inference tests.
- [ ] Commit as `feat(schema): add Standard Schema classes`.

### Task 8: #218 — TaggedClass and TaggedError

**Files:** `src/classes/tagged-class.ts`, `src/classes/tagged-error.ts`, tagged tests.

- [ ] Add safe discriminant/tag declaration, protected identity, inheritance, and error matching.
- [ ] Keep tagged error construction distinct from throwing and return typed construction/definition failures.
- [ ] Verify JSON-safe diagnostics and better-result pattern matching.
- [ ] Commit as `feat(schema): add tagged classes and errors`.

### Task 9: #219 — Structural derivation engine

**Files:** `src/derivation/`, object policy/capability integrations, derivation tests.

- [ ] Implement extend/pick/omit/partial/exactPartial/deepPartial/required and strict/loose/strip/catchall policies.
- [ ] Preserve refinements, tags, defaults, codecs, optionality, protected fields, and multi-field rules.
- [ ] Reject non-preservable transforms with typed unsupported failures.
- [ ] Add positive and negative runtime/type coverage, including masks and recursive structures.
- [ ] Commit as `feat(schema): add structural derivations`.

### Task 10: #220 — Optional Zod adapter

**Files:** `src/adapters/zod/`, adapter tests and package subpath exports.

- [ ] Implement explicit Zod adapter capabilities and full parity matrix from #210.
- [ ] Keep Zod-only imports in the adapter and preserve native composition only where explicitly supported.
- [ ] Cover Zod codecs, classes, derivations, refinements, defaults, error paths, and no-throw behavior.
- [ ] Commit as `feat(schema): add optional Zod adapter`.

### Task 11: #221 — Optional Valibot adapter

**Files:** `src/adapters/valibot/`, adapter tests and subpath integration.

- [ ] Implement Standard Schema and supported Valibot capabilities without importing Valibot into core.
- [ ] Expose a matrix of supported/unsupported operations with typed negative cases.
- [ ] Add runtime and type tests for validation, construction, defaults, and transformations actually preserved.
- [ ] Commit as `feat(schema): add optional Valibot adapter`.

### Task 12: #222 — Optional ArkType adapter

**Files:** `src/adapters/arktype/`, adapter tests and subpath integration.

- [ ] Implement callable ArkType integration, morph preservation, and supported construction capabilities.
- [ ] Avoid reversing morphs or delegating arbitrary internals through a proxy.
- [ ] Add runtime/type tests for callable validation, morphs, failures, and unsupported operations.
- [ ] Commit as `feat(schema): add optional ArkType adapter`.

### Task 13: #224 — Safe JSON Schema and metadata

**Files:** `src/json-schema/`, metadata capabilities, JSON Schema tests.

- [ ] Implement `Schema.toJSONSchema(schemaOrModel, { side, target, libraryOptions })` as a safe Result operation.
- [ ] Support input/output side semantics, metadata, targets, `$ref`/`$defs`, Standard JSON Schema providers, and explicit converter capabilities.
- [ ] Capture throwing getters/converters and reject unsupported/invalid targets without `{}`/`true` permissive fallbacks.
- [ ] Commit as `feat(schema): add safe JSON Schema conversion`.

### Task 14: #223 — Standard bridge and public facade

**Files:** `src/standard/`, `src/index.ts`, `src/schema.ts`, bridge tests.

- [ ] Make classes/TaggedError usable as Standard Schema values with native protocol return shapes.
- [ ] Ensure bridge conversion does not repeat decode/construction and preserves type inference.
- [ ] Reconcile facade exports and adapter subpaths with the stable contract.
- [ ] Commit as `feat(schema): expose Standard Schema bridge`.

### Task 15: #225 — Integrated conformance and type contracts

**Files:** `tests/conformance/`, `tests/types/`, package boundary/external consumer fixtures.

- [ ] Run universal contracts against a hand-written Standard Schema, Zod, Valibot, ArkType, and a custom public adapter.
- [ ] Add explicit negative tests for missing capabilities and every adversarial no-throw case in #209.
- [ ] Verify class/codec/derivation/JSON Schema interoperability, declaration independence, and bounded diagnostics.
- [ ] Record provider/version matrix and performance smoke results.
- [ ] Commit as `test(schema): add multi-provider conformance suite`.

### Task 16: #226 — Cutover, legacy removal, docs, and consumers

**Files:** package/root docs, examples, real consumers, exports/manifests, migration and changelog files.

- [ ] Remove core Zod proxy, `_zod`, Zod-specific root exports, throwing paths, and duplicate legacy implementations.
- [ ] Migrate real consumers semantically to Result/Effect, decode, explicit capabilities, and the new package name.
- [ ] Update README, API/architecture docs, migration guide, examples, changelog, and verification notes.
- [ ] Commit as `refactor(schema): complete provider-neutral cutover`.

### Task 17: #227 — Tarballs, peers, CI, and release gate

**Files:** package scripts, CI/release routing, external fixtures, `VERIFICATION.md`.

- [ ] Build and inspect the real tarball with Bun and npm pack dry runs; verify allowlists, declarations, source maps, and no workspace references.
- [ ] Install isolated core-only, Zod-only, Valibot-only, ArkType-only, JSON Schema, and all-provider consumers outside the workspace.
- [ ] Run package and monorepo typecheck/lint/format/build/publint/check gates with exact versions.
- [ ] Record commit, commands, results, tarball checksum, peer matrix, and any unavailable gate without claiming release readiness when evidence is missing.
- [ ] Commit as `test(schema): verify external package release gate`.

## Final integration

- [ ] Review every child diff for shared-file conflicts and provider leakage.
- [ ] Re-run #225 after #226 is integrated.
- [ ] Run fresh `bun run check` and package `check`, then inspect `git status --short`.
- [ ] Confirm no remote release/tag/publication occurred.
- [ ] Confirm all 17 child issues have a separate PR targeting `main` and that no PR was silently folded into another.
- [ ] Update the #209 checklist only if remote issue mutation is explicitly requested later; this task does not mutate GitHub.
