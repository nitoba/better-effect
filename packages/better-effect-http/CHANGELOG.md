# Changelog

## Unreleased

### Changed

- Updated the `better-effect` peer range to `>=0.14.0 <0.15.0` and aligned the
  workspace schema artifact with `better-effect-schema@0.1.1`.

## [0.1.0] - 2026-09-07

Initial development package boundary for `better-effect-http`.

- Add an independent ESM package with an `ofetch` implementation dependency.
- Add build, declaration, package-boundary, and external-consumer gates.
- Add lazy HTTP operations with status-aware Standard Schema response validation.
- Keep schema-provider integrations optional; the core decoder depends only on
  the public `better-effect-schema` API.
