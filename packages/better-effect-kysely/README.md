# better-effect-kysely

**Experimental server-side integration between `better-effect` and Kysely.**

`better-effect-kysely` is an independent package in the `better-effect`
monorepo. It is being developed to connect Kysely's native, type-safe SQL
builder and executor with the Service, Layer, Effect, Runtime, Scope,
cancellation, and typed-error boundaries provided by `better-effect`.

Kysely remains the query builder, compiler, executor, dialect boundary, and
driver integration. This package will not become an ORM, repository framework,
or replacement for Kysely's native APIs.

## Status

The package foundation is available for the v0.1 integration work. The
functional Service and query APIs are intentionally introduced in follow-up
changes; no placeholder API is published by this foundation.

## Installation

The package is planned to be installed with its peers:

```bash
bun add better-effect-kysely better-effect better-result kysely
```

Drivers such as `better-sqlite3`, `pg`, `mysql2`, or PGlite remain explicit
application choices. They are not bundled or required by the package
entrypoint.

## Design boundary

The integration will adapt Kysely's Promise-based execution boundary without
changing Kysely itself. The planned public terminal uses Kysely's native
`$call(...)` API rather than making builders directly yieldable.

There are deliberately no prototype patches, recursive Proxies, global module
augmentations, driver choices, connection creation, or import-time database
side effects.

## License

MIT
