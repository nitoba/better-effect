# Architecture

`better-effect-schema` has a small provider-neutral core and optional adapter
subpaths.

```text
application boundary
        │ unknown / encoded value
        ▼
better-effect-schema core ── Standard Schema ──► Result / Effect
        ▲
        │ local facade
Zod / Valibot / ArkType adapter
```

## Core

The core owns:

- `Schema.Class`, `Schema.TaggedClass`, and `Schema.TaggedError`;
- Standard Schema validation and class construction;
- explicit codec operations and typed failures;
- `better-result`-backed, requirement-free Effect values;
- public type projections such as `Schema.Props` and `Schema.Encoded`.

The core does not import provider packages, inspect provider-private fields, or
provide a native parser surface.

## Adapters

An adapter owns native schema identity, object policies, field maps, bridge
operations, provider class factories, and provider-specific derivations. The
adapter is selected explicitly:

```ts
const Local = Schema.with(ZodAdapter)
```

`Schema.with` creates an immutable local facade. There is no global provider
registry and no provider state in `Schema`.

## Data flow

```text
encoded input
    │ Schema.decode / decodeUnknown
    ▼
decoded props
    │ Schema.make / class constructor
    ▼
class instance
    │ explicit Schema.encode capability
    ▼
encoded output
```

Expected validation problems remain typed `Result` errors. Provider throws and
rejections become `SchemaExecutionFailure`; a sync boundary that observes an
async operation returns `SchemaAsyncRequired`.

## Package boundary

The root export is provider-neutral. `./zod`, `./valibot`, and `./arktype` are
separate optional-peer entrypoints. Public declarations expose no internal
implementation modules, and the package archive contains the documentation
allowlist without source or test fixtures.
