# Changelog

## Unreleased

### Changed

- Renamed the workspace package and release-artifact route from `better-effect-zod` to `better-effect-schema`.
- Added `@standard-schema/spec` as a production dependency for future public type declarations.

## [0.1.1] - 2026-09-09

### Added

- Added preconfigured `Schema` facades to the `better-effect-schema/zod`,
  `better-effect-schema/valibot`, and `better-effect-schema/arktype`
  subpaths, including shared namespace type helpers and provider-native class
  and derivation capabilities.

### Changed

- Provider integrations remain optional and provider-neutral code stays on the
  root entrypoint, while provider-specific classes and operations can use the
  matching facade without manually calling `Schema.with`.
- Added explicit JSON-safe encoding for Zod-backed tagged classes and errors,
  and updated the `better-effect` peer range to `>=0.14.0 <0.15.0`.

### Documentation

- Refreshed the README, API and architecture references, provider quick starts,
  migration guide, and runnable examples to use the preconfigured provider
  facades and schema-first interoperability patterns.

## [0.1.0] - 2026-09-09

Initial release of `better-effect-schema`, completing the provider-neutral schema cutover.

### Added

- Provider-neutral Standard Schema classes, tagged classes and errors, codec operations, JSON Schema utilities, and `better-result`-backed failures from the root package entrypoint.
- Optional provider adapters at `better-effect-schema/zod`, `better-effect-schema/valibot`, and `better-effect-schema/arktype`; provider packages remain optional peer dependencies and are not loaded by the root entrypoint.
- `better-effect` integration for typed schema operations and Effect-compatible results.
- Public migration, architecture, and provider interoperability documentation.

## [Historical] `better-effect-zod@0.1.0` - 2026-09-02

Initial release under the `better-effect-zod` package identity, based on `zod-class@0.2.0`.

### Added

- Preferred `Schema` facade with `Class`, `TaggedClass`, `TaggedError`, guards, operations, and namespace type helpers.
- Requirement-free `Schema.decodeUnknown`, `decode`, `encode`, `make`, and asynchronous variants returning `Effect<_, _, never>` values backed by `better-result`.
- `SchemaDecodeFailure`, `SchemaEncodeFailure`, and `SchemaConstructionFailure` with bounded issues, safe JSON, and non-enumerable in-memory Zod causes.
- `Schema.TaggedError` integration with the `better-result.TaggedError` runtime protocol, including direct yieldability, exhaustive matching, static guards, and serialization.
- Explicit `unsafeMake` construction escape.
- Ecosystem recipes for better-effect, Kysely, better-effect-mq, and HTTP boundaries.
- Migration guide from `zod-class@0.2.0`.

### Changed

- Package renamed from `zod-class` to `better-effect-zod`.
- Package output is ESM-only.
- Public documentation and examples use `Schema` instead of `Z`.
- Package-contract exceptions are named `BetterEffectZodError`.
- Runtime identity symbols use the `better-effect-zod` namespace.
- Tagged-error schemas additionally reserve `match` and `toJSON`.
- Normal construction paths always validate decoded properties.

### Compatibility

- `Z` remains a deprecated alias for `Schema`.
- `ZodClassError` and `ZodClassErrorCode` remain deprecated aliases.
- Existing class, codec, projection, derivation, metadata, JSON Schema, recursive-schema, and object-mode behavior is retained.

### Removed

- CommonJS build and export.
- Public `{ disableChecks: true }` constructor and `make` options. Use `unsafeMake` for an explicit trusted bypass.
