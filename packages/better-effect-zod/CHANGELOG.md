# Changelog

## 0.1.0 - 2026-09-02

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
