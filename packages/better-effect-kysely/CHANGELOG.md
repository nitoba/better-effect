# Changelog

## Unreleased

- Add the independent `better-effect-kysely` package foundation.
- Add yieldable Kysely Service tokens with typed schema preservation.
- Add explicit owned (`layer`) and borrowed (`succeed`) Layer lifecycle helpers.
- Establish ESM exports, peer dependency boundaries, package audits, and an
  isolated external consumer gate for the v0.1 implementation.
- Add the yieldable `KyselyOperation` contract, Runtime signal forwarding, and
  safe typed query and transaction boundary errors.
- Add lazy native query terminals for execute, first-row, first-row-or-fail, and
  raw or compiled query execution.
