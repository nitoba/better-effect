## 1. Public API and Service boundary

- [x] 1.1 Define the public Config source options, Standard Schema output aliases, reusable ConfigValue type, and tagged validation/source error contracts without adding a validator dependency.
- [x] 1.2 Add the optional Config standard Service under `better-effect/standard-services`, including arbitrary-source Layer creation, environment-source Layer creation, and the default live export.
- [x] 1.3 Export the new Config APIs and types through the standard-services subpath while keeping the core package free of an implicit Config provider.

## 2. Environment source loading

- [x] 2.1 Implement host-environment resolution for `process.env`, `Bun.env`, and explicit in-memory `envSource` values without coercing or filtering raw strings.
- [x] 2.2 Implement `dotEnvPath` loading with the documented minimal dotenv grammar, merge dotenv values below explicit environment-source values, and normalize read/parse failures as configuration source errors.
- [x] 2.3 Keep source loading isolated from public APIs, avoid global mutable caches, and add safe diagnostics that never include raw configuration values.

## 3. Schema-bound descriptors and composition

- [x] 3.1 Implement reusable `Config.fromEnv({ schema, dotEnvPath?, envSource? })` descriptors whose fresh async iterators load the source and validate through `schema["~standard"].validate`.
- [x] 3.2 Implement provider-backed `Config.schema(schema)` descriptors that resolve the contextual Config Service and support `Config.layer(source)` and `Config.layerFromEnv(options)` replacement.
- [x] 3.3 Add the typed source combinator used with the existing functional `pipe` helper, preserving Standard Schema output, configuration errors, and provider requirements without adding a `.pipe()` method.
- [x] 3.4 Integrate synchronous and asynchronous Standard Schema results with `better-result` Result generators, preserving validation errors and `UnhandledException` normalization at Effect boundaries.
- [x] 3.5 Preserve Service requirement inference for provider-backed descriptors and Service methods, while keeping ConfigValue yields out of the current `Layer.gen` protocol.

## 4. Runtime and type-contract tests

- [x] 4.1 Add runtime tests for successful transformed output, reusable descriptors, synchronous validators, asynchronous validators, and direct `yield*` consumption in Effect programs.
- [x] 4.2 Add source tests for explicit `envSource`, host-environment defaults, dotenv loading, precedence, empty strings, missing files, malformed files, and safe error diagnostics.
- [x] 4.3 Add provider tests for arbitrary Config Layers, environment Layers, Layer overrides, and missing-provider behavior without a hidden global source.
- [x] 4.4 Add type tests asserting exact `StandardSchemaV1.InferOutput` values, validation/source error channels, pipe composition, and configuration use inside another Service.

## 5. Documentation and examples

- [x] 5.1 Document the one-call `Config.fromEnv` workflow with `dotEnvPath` and `envSource`, including Zod/Valibot-compatible Standard Schema examples and Result error handling.
- [x] 5.2 Document the advanced provider-backed `Config.schema` plus Layer workflow and explain when to use it instead of the bound descriptor.
- [x] 5.3 Replace the current product-specific Config example with the standard Config API and update affected examples to show typed access inside Services.

## 6. Verification

- [x] 6.1 Run formatting, typechecking, lint, tests, build, package inspection, and the complete `bun run check` command.
