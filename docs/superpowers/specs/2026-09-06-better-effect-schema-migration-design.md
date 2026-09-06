# better-effect-schema migration design

## Context

Issue #209 migrates `packages/better-effect-zod` to `packages/better-effect-schema`.
The package keeps its modeling and class capabilities while moving validation to
the provider-neutral Standard Schema protocol. Zod, Valibot, and ArkType remain
optional adapters; the root package must not import any of them at runtime or in
its generated declarations.

The package is a consumer of `better-result` and `better-effect`, not a second
effect runtime. Every fallible public operation returns a real `Result` through
`Effect<A, E, never>` (or a Promise of that result for async operations). The
package catches failures from code it invokes, while preserving the original
cause privately and exposing bounded, safe diagnostics.

## Goals and non-goals

Goals:

- preserve the public modeling surface identified in #210, with explicit
  migration paths where the old Zod semantics threw or returned Zod-specific
  values;
- make Standard Schema decode work without an adapter;
- model optional capabilities explicitly for encoding, fields, construction,
  derivation, and JSON Schema;
- keep class declarations usable in `extends`, with real instances, identity,
  inheritance, tagged classes/errors, and safe `make` operations;
- verify runtime, type, package-boundary, and external-tarball behavior.

Non-goals:

- adding Context, Runtime, Layer, Scope, Fiber, scheduler, or EffectTS;
- turning the package into a universal proxy for provider internals;
- making encoding, JSON Schema, field introspection, or derivation implicit in
  Standard Schema;
- keeping `better-effect-zod` as a permanent compatibility package or shim;
- publishing, tagging, deprecating, or releasing anything during this work.

## Package architecture

```text
packages/better-effect-schema/
  src/
    index.ts                 public root facade
    schema.ts                namespace facade and type aliases
    schema-effect.ts         Effect<A, E, never> alias
    failure.ts               provider-neutral tagged failures
    operations/              decode, encode, construct boundaries
    capabilities/            explicit portable capability contracts
    codecs/                  explicit codec and projection operations
    classes/                 Class, TaggedClass, TaggedError, identity
    derivation/              structural derivations and object policies
    standard/                Standard Schema bridge
    json-schema/             Standard JSON Schema and safe conversion
    adapters/{zod,valibot,arktype}/
    types/                   public input/output/props/instance inference
    internal/                 bounded execution and diagnostic helpers
  tests/{operations,classes,adapters,conformance,types,package}/
```

The internal provider representation may erase concrete types at its boundary,
but every public constructor and operation remains generic over a concrete
Standard Schema or capability contract. Adapters own all provider-specific
imports and identifiers. `Schema.with(adapter)` is a local declarative
configuration and never mutates a global registry.

## Public contracts

```ts
import type { Effect } from "better-effect"

export type SchemaEffect<A, E> = Effect<A, E, never>

Schema.decodeUnknown(schema, input): SchemaEffect<Output<typeof schema>, SchemaDecodeFailure>
Schema.decodeUnknownAsync(schema, input): Promise<SchemaEffect<Output<typeof schema>, SchemaDecodeFailure | SchemaExecutionFailure>>
Schema.toJSONSchema(schema, options): SchemaEffect<JsonSchemaDocument, ConversionErrors>
```

Synchronous APIs never return an unstable `Result | Promise` union. If a sync
provider returns a Promise/thenable, the operation returns `SchemaAsyncRequired`
and observes the pending rejection so it cannot become unhandled. Async APIs
accept both sync and async Standard Schema validators and invoke the validator
exactly once.

`~standard.validate` remains native protocol output (`{ value }`, `{ issues }`,
or a Promise of one), never a `Result`. The package's bridge captures malformed
protocol values, throwing getters, callbacks, constructors, converters, and
thenables at its own boundaries.

## Failure and diagnostics model

The stable operation failures are:

- `SchemaDecodeFailure`
- `SchemaEncodeFailure`
- `SchemaConstructionFailure`
- `SchemaDefinitionFailure`
- `SchemaExecutionFailure`
- `SchemaUnsupportedOperation`
- `SchemaAsyncRequired`

Each error has `_tag`, a safe operation/identifier label, and bounded normalized
issues where relevant. An external `cause: unknown` is retained as a
non-enumerable in-memory property only. Public JSON omits cause, stack, payload,
and arbitrary provider messages. Normalization and serialization must remain
safe for cyclic objects, BigInt, Symbols, proxies, hostile getters, and custom
serialization methods.

## Data flow

```text
consumer input
  -> Standard Schema bridge (or explicit adapter capability)
  -> one invocation boundary
  -> normalized success / typed failure
  -> better-result Result inside SchemaEffect

Class.make(props)
  -> props capability / construction schema
  -> real instance construction
  -> instance validation and identity
  -> Result<Instance, SchemaConstructionFailure | SchemaExecutionFailure>
```

Class builders used in `extends` are declarative. They retain invalid
definitions and expose them through `Schema.check` and all later operations;
they never execute validation against fabricated data and never replace a
failed definition with a permissive schema. `new` is not the validating public
boundary. `make`, `makeAsync`, and `unsafeMake` are safe Result-returning
factories, with `unsafeMake` only skipping validation.

## Adapter boundaries

The core accepts Standard Schema directly. Adapters expose only capabilities
they can implement, with negative typed results for missing or non-preservable
features. No adapter may import or modify another provider, register globally,
or expose provider-specific types from the root entrypoint.

- Zod: restore the existing functional matrix through explicit composition and
  a local adapter, without `_zod` or a universal proxy in core.
- Valibot: Standard Schema decode plus the documented native capabilities.
- ArkType: callable type, morphs, and construction where the provider supports
  them; preserve morph semantics instead of reversing transforms.

## Verification strategy

Every feature has runtime and type tests in its own issue. The final conformance
suite repeats the common contract with a hand-written Standard Schema, each
provider with and without its adapter, and a public custom adapter. The release
gate builds a real tarball and installs it into isolated external consumers for
core-only, Zod-only, Valibot-only, ArkType-only, JSON Schema, and all-provider
matrices.

The final gate is `bun run check` plus the package-specific check, with exact
versions and any unavailable infrastructure recorded in `VERIFICATION.md`.
