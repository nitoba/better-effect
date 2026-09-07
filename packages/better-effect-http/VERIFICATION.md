# Verification

The HTTP distribution gate runs from a clean temporary directory rather than
using the workspace's installed package links. It packs `better-effect`,
`better-effect-schema`, and `better-effect-http`, installs only the artifacts
needed by each consumer, checks the package export map and peer graph, compiles
the consumer declarations, and runs the smoke program under both Bun and Node.

## Consumer matrix

| Consumer     | Required packages                                                | Deliberately absent packages               |
| ------------ | ---------------------------------------------------------------- | ------------------------------------------ |
| `generic`    | better-effect, better-effect-schema, better-result               | Hono, OpenTelemetry, Zod, Valibot, ArkType |
| `integrated` | Hono, Zod, Valibot, ArkType and the core peers                   | OpenTelemetry                              |
| `telemetry`  | `@opentelemetry/api` and the HTTP artifact's required core peers | Hono and schema providers                  |

The generic cell proves that the main/testing/endpoints surface does not load
optional integrations. The telemetry cell proves that the optional
`@opentelemetry/api` peer is the only additional package needed for its
dedicated subpath. The integrated cell exercises the HTTP, schema-provider, and
Hono composition using the packed artifacts.

## Commands

```sh
bun install --frozen-lockfile
bun run build
bun run check
BETTER_EFFECT_HTTP_TYPESCRIPT_VERSION=6.0.0-beta bun run --cwd packages/better-effect-http test:package-consumer
```

The consumer script records the exact Bun, Node.js, and TypeScript versions,
the HTTP tarball SHA-256, isolated package versions, export targets, and
workspace-link checks. CI supplies the current Node.js LTS and runs the
consumer gate for the declared TypeScript floor probe (`6.0.0-beta`, the
earliest published TypeScript 6 build currently available) and current
compiler. The peer range remains `>=6.0.0` and does not depend on a
pre-release version.

This verification prepares distribution only. It does not create a tag,
GitHub Release, or npm publication.
