# better-effect-http

Layer-first HTTP client foundations for `better-effect`.

This package is the distribution boundary for the HTTP roadmap and currently
contains no public HTTP API. Transport, operations, typed errors, validation,
streaming, endpoints, and integrations are delivered by the downstream issues
tracked in [#229](https://github.com/nitoba/better-effect/issues/229).

The package is intentionally separate from `better-effect`. It uses `ofetch`
as its planned internal transport and does not make any network request, read
environment variables, create a Runtime, or register listeners during import.

## Development status

The package structure, build, package exports, and external-consumer checks are
in place for the initial development release. Do not depend on an HTTP client
export until a later roadmap issue adds and documents one.

```bash
bun add better-effect-http
```

The command above installs the package boundary only at this stage; no HTTP
client functions are exported yet.
