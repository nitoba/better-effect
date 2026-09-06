# better-effect-zod Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Convert the existing `zod-class` package into the workspace-ready `better-effect-zod` package, preserving its Zod Schema Class API while integrating typed `better-result` failures and requirement-free `better-effect` operations.

**Architecture:** Keep schema classes as immutable, requirement-free values built on native Zod codecs. Add a `Schema` facade and Result-backed decode/encode/construction boundaries. Build schema-backed tagged errors on top of `better-result`'s runtime `TaggedError`, so matching, yieldability, `toJSON`, and static guards remain the ecosystem's single error protocol.

**Tech Stack:** TypeScript >=5.7, Zod >=4.5.4 <5, better-result ^3.0.0, better-effect >=0.13.0 <0.14.0, Node.js test runner, ESM package output.

**Spec:** `docs/superpowers/specs/2026-09-01-zod-schema-class-design.md`, extended by the approved ecosystem analysis in the current conversation.

## Global Constraints

- Package name is `better-effect-zod`; the core `better-effect` package must not re-export it.
- Zod remains a peer dependency and no Zod internals are imported through private paths.
- `better-result` is the only Result and tagged-error protocol.
- Public schema operations return `Effect<A, E, never>` values, implemented as `better-result` Results.
- Schema validation never acquires Services; business validation remains in application Effects.
- Existing class, codec, derivation, registry, and metadata behavior remains compatible; the package is ESM-only because better-result is ESM-only.
- The legacy `Z` facade remains as a deprecated alias; new documentation and examples use `Schema`.
- Unexpected package-contract misuse remains a thrown `BetterEffectZodError`; invalid user data is represented by Zod or typed schema failures depending on the chosen API.
- Tests must cover runtime behavior, public types, package exports, external consumption, safe error serialization, and no generated dependencies, build output, caches, or Git metadata in the delivery ZIP, and no source/test leakage in the npm tarball.

---

### Task 1: Package identity and workspace-ready packaging

**Files:**
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/build.mjs`
- Modify: `scripts/check-source.mjs`
- Create: `docs/superpowers/specs/2026-09-02-better-effect-zod-integration-design.md`

**Interfaces:**
- Produces package name `better-effect-zod`, an ESM-only export map, peer dependency ranges, and verification commands used by all later tasks.

- [x] Rename package metadata, descriptions, keywords, and error names and align the build with an ESM-only layout that can run as a monorepo workspace.
- [x] Add `better-result` and `better-effect` peer/dev dependency declarations.
- [x] Add package-boundary and external-consumer checks to the verification pipeline.
- [x] Update source policy checks to reject stale `zod-class` identifiers and private package imports.

### Task 2: Typed schema failures and safe issue normalization

**Files:**
- Create: `src/failure.ts`
- Create: `src/internal/issues.ts`
- Modify: `src/errors.ts`
- Test: `tests/runtime/failure.test.mjs`
- Test: `type-tests/failure.ts`

**Interfaces:**
- Produces `SchemaDecodeFailure`, `SchemaEncodeFailure`, `SchemaConstructionFailure`, `SchemaIssue`, `SchemaIssuePath`, and `BetterEffectZodError`.

- [x] Write runtime and type tests for stable tags, safe JSON, bounded issue paths/messages, non-enumerable Zod causes, and exact constructor types.
- [x] Implement sanitized issue conversion from arbitrary Zod errors.
- [x] Implement the three failures with `better-result.TaggedError`.
- [x] Rename the package-contract exception while retaining `ZodClassError` as a deprecated compatibility alias.

### Task 3: Result/Effect schema operations

**Files:**
- Create: `src/operations.ts`
- Create: `src/internal/result.ts`
- Modify: `src/types/extractors.ts`
- Test: `tests/runtime/operations.test.mjs`
- Test: `type-tests/operations.ts`

**Interfaces:**
- Produces `decodeUnknown`, `decode`, `decodeUnknownAsync`, `decodeAsync`, `encode`, `encodeAsync`, `make`, and `makeAsync` with `Effect<_, _, never>` channels.

- [x] Test successful and failed decoding, encoding, construction, async validation, dual data-first/data-last forms, exact input/output inference, and generator yieldability.
- [x] Implement requirement-free Result adapters without throwing on expected Zod validation errors.
- [x] Preserve synchronous return values for synchronous APIs and Promise return values for async APIs.
- [x] Keep native Zod `parse`, `decode`, `encode`, `safeParse`, and class constructors unchanged.

### Task 4: Better-result-backed schema TaggedError

**Files:**
- Modify: `src/tagged-error.ts`
- Modify: `src/internal/class-types.ts`
- Modify: `src/internal/factory.ts`
- Modify: `src/internal/runtime-class.ts`
- Modify: `src/internal/tag.ts`
- Modify: `src/types/tagged.ts`
- Test: `tests/runtime/tagged.test.mjs`
- Test: `tests/runtime/tagged-result.test.mjs`
- Test: `type-tests/tagged.ts`

**Interfaces:**
- Produces schema-backed errors that are simultaneously `Error`, concrete schema-class instances, `better-result.AnyTaggedError`, directly yieldable failures, and exhaustively matchable values.

- [x] Test `yield* error`, `.match`, `TaggedError.is`, static concrete `.is`, safe `toJSON`, constructor validation, decoding, encoding, inheritance, and reserved names.
- [x] Allow generated runtime classes to use a custom runtime base factory.
- [x] Build the tagged-error base from `better-result.TaggedError(tag)` instead of native `Error`.
- [x] Preserve validated properties, message getters, causes, stack behavior, class identity, and Zod schema delegation.
- [x] Reserve `_tag`, `name`, `stack`, `match`, and `toJSON` from schema fields.

### Task 5: Public `Schema` facade and compatibility exports

**Files:**
- Create: `src/schema.ts`
- Modify: `src/z.ts`
- Modify: `src/index.ts`
- Modify: `src/types.ts`
- Test: `tests/runtime/smoke.test.mjs`
- Test: `type-tests/ergonomics.ts`

**Interfaces:**
- Produces `Schema.Class`, `Schema.TaggedClass`, `Schema.TaggedError`, operations, guards, and type namespace helpers. Keeps top-level exports and deprecated `Z` alias.

- [x] Add tests proving facade and top-level exports reference the same functions and types.
- [x] Implement the frozen `Schema` facade and declaration namespace.
- [x] Mark `Z` and legacy package-contract names deprecated without removing runtime compatibility.
- [x] Ensure root exports expose only supported public APIs.

### Task 6: Unsafe construction boundary and class API hardening

**Files:**
- Modify: `src/types/common.ts`
- Modify: `src/types/schema-class.ts`
- Modify: `src/internal/runtime-class.ts`
- Modify: `src/internal/instance.ts`
- Test: `tests/runtime/construction.test.mjs`
- Test: `type-tests/class-api.ts`

**Interfaces:**
- Produces `unsafeMake` as the explicit public bypass and removes public `disableChecks` from normal constructor/make options while retaining a private internal prevalidated path.

- [x] Test that normal construction cannot bypass checks and that `unsafeMake` preserves class/tag identity without validation.
- [x] Move the unchecked construction token to a private module-only capability.
- [x] Add static `unsafeMake` and keep async/safe construction paths validated.
- [x] Update types so callers cannot pass `{ disableChecks: true }`.

### Task 7: Ecosystem recipes, documentation, and migration guide

**Files:**
- Rewrite: `README.md`
- Modify: `docs/api.md`
- Modify: `docs/architecture.md`
- Create: `MIGRATION.md`
- Rewrite: `CHANGELOG.md`
- Modify/Create examples under `examples/`
- Modify: `VERIFICATION.md`

**Interfaces:**
- Documents class modeling, typed schema boundaries, Kysely row decoding, MQ Standard Schema usage, Hono/Next request validation, and the structural/business validation boundary.

- [x] Replace public branding and examples with `better-effect-zod` and `Schema`.
- [x] Add executable examples for Effect workflows, tagged errors, Kysely rows, and MQ codecs without introducing runtime coupling to optional integrations.
- [x] Explain native throwing Zod APIs versus Result-backed APIs.
- [x] Document compatibility aliases and migration from `zod-class`.
- [x] State verification limitations honestly when registry access is unavailable.

### Task 8: Final package verification and clean archive

**Files:**
- Create/Modify package test scripts under `scripts/` and `tests/package/`
- Produce: `/mnt/data/better-effect-zod-0.1.0.zip`

**Interfaces:**
- Produces a clean source archive suitable for copying to `packages/better-effect-zod` in the monorepo.

- [x] Run source/type/build/runtime/example/package checks available in the environment.
- [x] Inspect generated declarations and the ESM entrypoint.
- [x] Pack and install the tarball in a temporary external consumer when dependencies are available.
- [x] Remove `node_modules`, build outputs, npm caches, and Git metadata from the delivery copy.
- [x] Generate the ZIP and inspect its file listing and checksum.
