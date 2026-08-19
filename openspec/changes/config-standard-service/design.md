## Context

The existing library keeps `Effect` as a typed facade over `better-result` and
uses class-backed Services as runtime tokens and yieldable dependencies. Layers
store heterogeneous providers and `Layer.gen` currently accepts only Service
yields. Standard services are optional and live under the
`better-effect/standard-services` subpath.

`better-result` already exposes the Standard Schema V1 contract, including
output inference and synchronous/asynchronous validation. The implementation
must therefore add a small configuration boundary without turning `Effect` into
a lazy instruction tree, adding a validator dependency, or importing a DI
container.

## Goals / Non-Goals

**Goals:**

- Make the common environment workflow a single declaration:
  `Config.fromEnv({ schema, dotEnvPath?, envSource? })`.
- Return schema output types through `yield*` and preserve configuration errors
  in Effect/Result metadata.
- Keep a provider-backed `Config.schema(schema)` form for applications that want
  to install and override a source through Layers.
- Support host environment objects, in-memory test sources, and an explicit
  dotenv file without a runtime validator dependency.
- Keep source loading lazy, execution-local where relevant, and safe for secret
  values.

**Non-Goals:**

- Recreating Effect's full `ConfigProvider` tree/path/combinator system.
- Inferring environment key paths from arbitrary Standard Schema metadata.
- Adding `Config.all`, `nested`, default, option, fallback, or provider file
  directory combinators in this change.
- Making `Runtime.make` eagerly validate every schema-bound configuration.
- Allowing a Result-producing configuration descriptor to be yielded from the
  current `Layer.gen` implementation.
- Adding a prototype `.pipe()` method or making the generic `pipe` helper aware
  of Config, Effect, Result, Promise, Scope, or Service metadata.

## Decisions

### 1. Keep the one-call environment API separate from the Layer API

`Config.fromEnv({ schema, dotEnvPath?, envSource? })` returns a reusable,
schema-bound `ConfigValue<S>`. It owns the source options for that descriptor,
so an application can write `const AppConfig = Config.fromEnv(...)` and yield
`AppConfig` without declaring an unrelated `ConfigLive`.

The provider-oriented APIs remain explicit and separate:

- `Config.schema(schema)` returns a descriptor backed by the contextual Config
  Service.
- `Config.layer(source)` supplies an arbitrary raw source through a Layer.
- `Config.layerFromEnv(options?)` supplies a dotenv/host-environment source
  through a Layer.

`fromEnv` MUST NOT return a Layer in one overload and a descriptor in another.
That would make the return type and lifecycle depend on whether `schema` was
present. The two forms share internal source-loading helpers instead.

### 2. Represent a ConfigValue as a reusable yieldable descriptor

`ConfigValue<S>` is a public-facing type whose async iterator creates a fresh
generator for every `yield*`. The iterator loads its bound source (or resolves
the contextual Config Service for `Config.schema`), invokes
`schema["~standard"].validate`, and returns `StandardSchemaV1.InferOutput<S>`.

The runtime path uses `better-result`'s existing Result generator and awaiting
helpers. A validation result with issues becomes a tagged validation error; a
source read/parse failure becomes a tagged source error; unexpected validator
exceptions use `UnhandledException` normalization.

The descriptor is async-capable because Standard Schema validators may return a
Promise. A separate synchronous API is not introduced; synchronous schemas are
still supported when used through an async Effect boundary.

### 3. Make source options deterministic and schema-agnostic

`envSource` is an explicit raw record such as `process.env`, `Bun.env`, or a
test object. If omitted, the host environment available at execution is used.
`dotEnvPath` is a filesystem path to one dotenv file, not a schema key prefix.

When both sources exist, dotenv values form the base and explicit `envSource`
keys override them. Raw strings, including empty strings, are passed unchanged
to the schema. Defaults, coercion, trimming, and required/optional semantics
remain the validator's responsibility.

Dotenv loading is isolated behind a small internal source loader using host file
APIs. The change does not add a dotenv package. The parser supports the common
dotenv surface needed by the package (blank lines, comments, `KEY=value`,
quoted values, and optional `export`) and deliberately does not add variable
expansion or directory/config-map discovery.

### 4. Keep standard-service and source replacement semantics explicit

`Config` is declared in `standard-services` with the same Service identity and
Layer rules as Clock, Random, and Logger. No import installs a provider or reads
the process environment globally.

`Config.layer(source)` creates a provider for an arbitrary already-loaded value.
`Config.layerFromEnv(options)` uses the same environment source loader as
`Config.fromEnv`. `Layer.override` remains the explicit mechanism for replacing
one provider with another in tests or application composition.

### 5. Use functional pipe combinators without changing core pipe

If a source-bound descriptor needs to be assembled incrementally, expose a
unary `Config.withEnv(options)` (or equivalent source combinator) that preserves
the descriptor's schema output and error channels. It is consumed with the
existing function form:

```ts
const AppConfig = pipe(
  Config.schema(EnvSchema),
  Config.withEnv({ dotEnvPath: '.env', envSource: process.env })
)
```

No prototype `.pipe()` method is added. The generic `pipe` implementation stays
unaware of Config and only composes the typed unary functions supplied to it.

### 6. Do not use ConfigValue in Layer.gen

`Layer.gen` has a narrower contract than `Effect.gen`: it resolves Service
tokens while acquiring one provider and rejects other runtime yields. A
ConfigValue can fail through a Result, so yielding it from `Layer.gen` would
require a new Layer error/Result protocol. This change keeps configuration
consumption in Effects and Service methods. Startup validation can be expressed
as an explicit bootstrap Effect later without changing Layer semantics.

### 7. Preserve type and error metadata at boundaries

The ConfigValue iterator yield type will carry the existing Service requirement
marker for provider-backed descriptors and the existing `Err` marker for
configuration failures. This lets `EffectFromGenerator`, Service requirement
inference, `Runtime.run`, and typed Layer checks retain the output, error, and
Config requirement channels without runtime metadata.

Public errors should expose issue paths/messages and source diagnostics, but not
the raw input object. Error construction and schema invocation remain localized
to the standard-service module; no low-level source loader helpers are exported.

## Risks / Trade-offs

- [Bound descriptors do not share a mutable provider] → `Config.fromEnv` is the
  ergonomic application API; use `Config.schema` plus `Config.layerFromEnv` when
  several descriptors must share an overridable provider.
- [Dotenv parsing can differ between runtimes] → isolate the loader, support a
  documented minimal grammar, and test it independently; callers can always
  provide a fully parsed `envSource`.
- [Validation is lazy rather than automatically performed by `Runtime.make`] →
  document an explicit bootstrap Effect for applications that want startup
  failure before accepting work.
- [An async-first descriptor cannot be yielded by a synchronous generator] →
  keep the public examples and type contract async, matching Standard Schema's
  ability to perform asynchronous validation.
- [Configuration errors may contain sensitive paths or messages] → never attach
  raw source values and keep diagnostics limited to schema issues and safe source
  metadata.

## Migration Plan

This is an additive optional standard service. Existing applications and
adapters remain unchanged. Add the new subpath exports, tests, and documentation
alongside the current APIs, then update the documentation example that declares
a product-specific `Config` Service to use the standard service. If the change
is rolled back, remove the new exports and leave existing application Services
and Layers intact.
