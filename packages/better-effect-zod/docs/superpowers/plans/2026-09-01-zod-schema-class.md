# Zod Schema Class Implementation Plan

> Historical implementation plan for the predecessor package. Superseded by `2026-09-02-better-effect-zod-integration.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Build a publishable Effect-inspired class API for Zod 4.5 that separates encoded data, decoded constructor props, and class instances.

**Architecture:** Generated classes are proxy facades over lazily-built real Zod codecs. A descriptor registry owns class metadata and derivation, while focused modules handle construction, identity, codec creation, schema delegation, and tagged error behavior.

**Tech Stack:** TypeScript 6.x target, Zod >=4.5.4 <5, Node.js test runner, npm package exports.

**Spec:** `docs/superpowers/specs/2026-09-01-zod-schema-class-design.md`

## Global Constraints

- Support Zod `>=4.5.4 <5`; do not support Zod 3.
- Do not override `_parse`, `_parseSync`, or `_parseAsync`.
- Do not construct Zod wrapper classes directly.
- Do not use `@ts-ignore`.
- Do not expose `any` in the public API.
- Keep `zod` as a peer dependency and the only runtime dependency.
- Build both ESM and CommonJS artifacts with declarations.
- Preserve the original implementation under `docs/reference`.

---

### Task 1: Package scaffold and executable test harness

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.build.json`
- Create: `tsconfig.type-tests.json`
- Create: `scripts/build.mjs`
- Create: `scripts/test-runtime.mjs`
- Create: `tests/runtime/smoke.test.mjs`

**Interfaces:**
- Produces scripts `build`, `test:runtime`, `test:types`, `test`, and `check`.

- [x] Write a smoke test that imports `dist/esm/index.js` and asserts `Z.Class` is exported.
- [x] Run the runtime test and confirm it fails because the build is absent.
- [x] Add package/build configuration and the minimal public export needed to make the smoke test pass.
- [x] Run the smoke test and build.

### Task 2: Descriptor, identity, and decoded construction

**Files:**
- Create: `src/internal/symbols.ts`
- Create: `src/internal/descriptor.ts`
- Create: `src/internal/instance.ts`
- Create: `src/errors.ts`
- Create: `tests/runtime/construction.test.mjs`

**Interfaces:**
- Produces `ClassDescriptor`, descriptor lookup/registration, `constructProps`, `assignProps`, `hasIdentifier`, and `ZodClassError`.

- [x] Write failing tests for constructor validation, `make`, `disableChecks`, empty classes, and stable identity.
- [x] Implement the descriptor and instance utilities minimally.
- [x] Run focused tests and then the full runtime suite.

### Task 3: Codec creation and schema delegation

**Files:**
- Create: `src/internal/codec.ts`
- Create: `src/internal/proxy.ts`
- Create: `tests/runtime/codec.test.mjs`

**Interfaces:**
- Produces `getClassCodec` and `createClassProxy`.

- [x] Write failing tests for decode, encode, nested field codecs, `z.array(Class)`, wrappers, safe methods, and invalid encode input.
- [x] Build a real lazy `z.codec` for each concrete class.
- [x] Delegate unresolved static schema properties/methods through the proxy.
- [x] Run focused and full runtime tests.

### Task 4: Public Class API and type helpers

**Files:**
- Create: `src/types.ts`
- Create: `src/internal/object-schema.ts`
- Create: `src/internal/factory.ts`
- Create: `src/class.ts`
- Create: `src/z.ts`
- Modify: `src/index.ts`
- Create: `type-tests/class-api.ts`

**Interfaces:**
- Produces `Z.Class`, `Z.Props`, `Z.Fields`, `Z.Encoded`, `Z.Instance`, and the documented static class surface.

- [x] Write compile-time tests for encoded/props/instance separation and invalid constructor inputs.
- [x] Implement the generic public types and class factory.
- [x] Run type tests and runtime tests.

### Task 5: Class derivation

**Files:**
- Create: `src/internal/derivation.ts`
- Create: `tests/runtime/derivation.test.mjs`
- Create: `type-tests/derivation.ts`

**Interfaces:**
- Produces `extend`, `pick`, `omit`, `partial`, and `required` class factories.

- [x] Write failing runtime and type tests for inherited methods, codecs, masks, and identifiers.
- [x] Implement derivation through object-schema operations and shared factory creation.
- [x] Run focused tests and all checks.

### Task 6: TaggedClass and TaggedError

**Files:**
- Create: `src/tagged-class.ts`
- Create: `src/tagged-error.ts`
- Create: `tests/runtime/tagged.test.mjs`
- Create: `type-tests/tagged.ts`

**Interfaces:**
- Produces `Z.TaggedClass` and `Z.TaggedError`.

- [x] Write failing tests for tag injection, encoded tags, instance checks, real `Error` behavior, stack/name/message, and type inference.
- [x] Implement tagged class/error factories with shared descriptors and codecs.
- [x] Run focused tests and all checks.

### Task 7: Metadata, JSON Schema, async, and recursion

**Files:**
- Create: `tests/runtime/advanced.test.mjs`
- Modify: internal modules as required by failing tests.

**Interfaces:**
- Completes metadata registry behavior, async factories, object-schema inputs, recursive classes, and JSON Schema input generation.

- [x] Write failing tests for metadata, `describe`, `register`, async refinements/codecs, `makeAsync`, recursive schemas, and full `ZodObject` inputs.
- [x] Implement only the missing behavior revealed by those tests.
- [x] Run all runtime and type tests.

### Task 8: Distribution, documentation, and examples

**Files:**
- Create: `README.md`
- Create: `MIGRATION.md`
- Create: `CHANGELOG.md`
- Create: `LICENSE`
- Create: `examples/basic.ts`, `examples/derivation.ts`, `examples/tagged-errors.ts`, and `examples/recursive.ts`
- Create: `.github/workflows/ci.yml`
- Modify: `package.json`

**Interfaces:**
- Produces a package that can be installed, built, tested, packed, and consumed in ESM or CommonJS.

- [x] Document the complete public API and migration from the original implementation.
- [x] Add an executable example and CI workflow.
- [x] Build and run the example against package output.
- [x] Run `npm pack --dry-run` and inspect the artifact list.

### Task 9: Final verification and clean archive

**Files:**
- Create: `VERIFICATION.md`
- Create outside project: `/mnt/data/zod-class-0.1.0-complete.zip`, `/mnt/data/zod-class-0.1.0.tgz`, and SHA-256 checksums

**Interfaces:**
- Produces a clean ZIP and a verification report with exact command evidence.

- [x] Run the complete clean-room verification command.
- [x] Scan sources for forbidden internals, `@ts-ignore`, and accidental public `any`.
- [x] Inspect package contents and repository status.
- [x] Write the verification report and create the ZIP excluding generated/cached dependencies.

### Task 10: Zod 4.5 output-side construction validation

**Files:**
- Create: `src/internal/output-projection.ts`
- Modify: `src/internal/instance.ts`
- Modify: `tests/runtime/construction.test.mjs`
- Modify: architecture, API, migration, and changelog documentation

**Interfaces:**
- Produces `getOutputProjection(schema)`, a cached wrapper over runtime `z.output(schema)`.

- [x] Add a regression test proving nested schema-class values preserve reference identity during checked construction.
- [x] Run the focused test and confirm the old encode/decode validation path fails it.
- [x] Replace construction round trips with direct output-side parsing.
- [x] Run the focused test and the complete check suite.
- [x] Update the approved design and user-facing documentation to match the corrected semantics.
