# Verification report

**Package:** `better-effect-zod@0.1.0`
**Date:** 2026-09-02

**Declared compatibility:** Zod `>=4.5.4 <5`, better-result `^3.0.0`, better-effect `>=0.13.0 <0.14.0`, TypeScript `>=6.0.0`, Node.js LTS, ESM only.

## Verified behavior

The package was verified for:

- schema classes built from Zod object shapes, Zod objects, and whole-object codecs;
- distinct encoded, decoded-props, and class-instance type channels;
- validated constructors, `make`, `makeAsync`, `safeMake`, and `safeMakeAsync`;
- explicit `unsafeMake` without a public `disableChecks` option;
- encoded and decoded schema projections;
- strict, loose, strip, catchall, extend, safeExtend, pick, omit, partial, exactPartial, deepPartial, and required derivations;
- tagged classes and better-result-compatible tagged errors;
- typed synchronous and asynchronous decode, encode, and construction operations;
- safe, bounded, serializable schema failures that omit rejected values;
- Zod composition, registries, JSON Schema, `compile`, `validate`, recursion, symbol keys, and class identity;
- external tarball consumption without resolving source files from the project workspace.

## Commands executed successfully

```bash
npm run typecheck
npm test
npm run examples:build
npm run examples:run
npm run check:source
npm run check:package
npm run test:package
npm pack --dry-run --ignore-scripts
```

The final local gate covered:

- **76 runtime tests:** 76 passed, 0 skipped, 0 failed;
- compile-time positive and negative API tests;
- **9 executable examples:** all compiled and executed;
- an external consumer compiled against the packed tarball and executed a schema round-trip plus the better-result TaggedError protocol;
- source-policy and package-boundary audits;
- npm archive inspection that rejects leaked `src`, tests, type tests, examples, `.git`, and `node_modules` content.

## Local environment

```text
Node.js:    v22.16.0
npm:        10.9.2
TypeScript: 5.8.3
Bun:        unavailable in this execution environment
```

## Dependency verification limitation

The execution environment could not resolve the npm registry or external package CDNs. It therefore could not install the declared official development dependencies during this run.

Local verification used a temporary compatibility harness under `node_modules` that models the public Zod 4.5.4, better-result 3.0.1, and better-effect 0.13.0 contracts exercised by the package. The implementation and type signatures were also compared with the corresponding public upstream source declarations. The harness is not part of the package source and is excluded from both the delivery ZIP and the npm tarball.

Because the official dependencies and Bun were unavailable here, this report does **not** claim that the complete official version/runtime matrix was executed locally. The package manifest and CI configuration retain the intended official versions so that the real matrix can run after the package is added to the monorepo.

## Required verification after adding to the monorepo

From the `better-effect` repository root:

```bash
bun install
cd packages/better-effect-zod
bun run check
cd ../..
bun run check
```

The monorepo run must use the official workspace packages and should verify at least:

```text
TypeScript 6.0+ with the workspace current version
Zod 4.5.4 and the current supported Zod 4 release
the current Node.js LTS used by CI
Bun 1.3.x used by the repository
```

## Source policy

Production sources contain none of the legacy or incompatible techniques below:

- no Effect TS or `@effect/*` dependency;
- no private `better-effect/*` or `better-result/*` imports;
- no `_parse`, `_parseSync`, or `_parseAsync` overrides;
- no legacy `ParseInput`, `ParseReturnType`, or `SyncParseReturnType` imports;
- no direct construction of Zod wrapper classes;
- no TypeScript suppression directives;
- no public or internal standalone `any` escape;
- no `type-fest` dependency;
- no `Object.create` allocation for class instances;
- no CommonJS entrypoint or `require` export condition.
