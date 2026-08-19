## Purpose

Provides a small, typed configuration boundary that loads raw environment data,
validates it through any Standard Schema implementation, and exposes the
decoded result directly to Effect programs and Services.

## ADDED Requirements

### Requirement: A schema-bound configuration is directly yieldable

The configuration API MUST provide `Config.fromEnv({ schema, dotEnvPath?, envSource? })` as a reusable, schema-bound descriptor. An application MUST be able to yield that descriptor directly from `Effect.gen`, `Effect.fn`, or an Effect-returning Service method without calling `parse` or another manual validation method. A successful yield MUST produce the schema's `StandardSchemaV1.InferOutput` type.

#### Scenario: An environment schema produces transformed typed output

- **WHEN** an application creates a configuration with a Standard Schema that validates environment values and transforms a numeric string into a number
- **THEN** yielding the configuration MUST return the transformed value with the schema output type

#### Scenario: The same descriptor is reused by multiple programs

- **WHEN** two Effect programs yield the same schema-bound configuration descriptor
- **THEN** each execution MUST receive a fresh validation result and MUST NOT consume a one-shot iterator from the descriptor

### Requirement: Standard Schema validation supports synchronous and asynchronous schemas

The configuration boundary MUST invoke the Standard Schema validation contract and MUST support validators whose `validate` operation returns either a result immediately or a Promise of a result. The configuration API MUST NOT depend on Zod, Valibot, Effect, or another concrete validator implementation.

#### Scenario: A synchronous schema succeeds

- **WHEN** a synchronous Standard Schema returns a successful validation result
- **THEN** yielding the configuration MUST complete with the schema output

#### Scenario: An asynchronous schema succeeds

- **WHEN** an asynchronous Standard Schema resolves a successful validation result
- **THEN** yielding the configuration MUST complete with the resolved schema output

### Requirement: Validation and source failures remain typed Effect errors

Validation issues MUST be returned through the Result/Effect error channel as a tagged configuration validation error containing the Standard Schema issues. Failures while reading or parsing an explicitly configured source MUST be returned as a tagged configuration source error. Unexpected exceptions or rejections from the validator MUST use the existing `UnhandledException` behavior. Configuration errors MUST NOT include raw environment values by default.

#### Scenario: Invalid input returns validation issues

- **WHEN** a required environment value is absent or fails the schema
- **THEN** yielding the configuration MUST produce an error containing the schema issues and MUST NOT return a partial output

#### Scenario: An environment file cannot be loaded

- **WHEN** `dotEnvPath` points to a source that cannot be read or parsed
- **THEN** yielding the configuration MUST produce a configuration source error

#### Scenario: A validator throws unexpectedly

- **WHEN** the Standard Schema validator throws or rejects for a reason other than reported validation issues
- **THEN** the Effect MUST expose the normalized `UnhandledException` error

### Requirement: Environment sources have explicit, deterministic options

`Config.fromEnv` MUST accept an optional `envSource` object and an optional `dotEnvPath` file path. When no source object is supplied, the implementation MUST use the host environment available to the runtime, including `process.env` or `Bun.env` where supported. When both a dotenv file and an environment source are present, explicit environment-source keys MUST override values loaded from the dotenv file. Values MUST remain raw until the schema validates them.

#### Scenario: An explicit source object is used

- **WHEN** an application supplies `envSource: { PORT: "3000" }`
- **THEN** configuration validation MUST read `PORT` from that object without requiring the process environment

#### Scenario: A dotenv file is combined with the host environment

- **WHEN** an application supplies `dotEnvPath` and `envSource`
- **THEN** values from the explicit environment source MUST take precedence over duplicate dotenv keys

#### Scenario: Empty strings are passed to the schema

- **WHEN** an environment source contains an empty string
- **THEN** the raw empty string MUST be passed to the Standard Schema and the schema MUST decide whether it is valid

### Requirement: Provider-backed configuration can be composed with Layers

The API MUST provide an advanced provider-backed form in which `Config.schema(schema)` describes a configuration read from the contextual Config Service, `Config.layer(source)` supplies an arbitrary source, and an environment Layer factory supplies a dotenv/host-environment source. These Layers MUST compose and override through the existing Layer contracts, and importing the configuration module MUST NOT install an implicit global provider.

#### Scenario: A test Layer replaces the configuration source

- **WHEN** an application overrides its production Config Layer with an in-memory source
- **THEN** the same schema-bound program MUST read only the replacement source

#### Scenario: No Config provider is installed

- **WHEN** a provider-backed `Config.schema(schema)` descriptor is yielded without a Config Layer
- **THEN** the execution MUST report the normal missing-Service requirement rather than reading a hidden global source

### Requirement: Configuration descriptors compose without losing their type channels

The API MUST support composing a provider/source operation with a schema descriptor through the package's functional `pipe` helper or equivalent public combinators. Composition MUST preserve the Standard Schema output type and configuration error channel. The API MUST NOT require a prototype-based `.pipe()` method.

#### Scenario: A source combinator is applied with `pipe`

- **WHEN** an application composes `Config.schema(schema)` with an environment-source combinator
- **THEN** yielding the composed descriptor MUST return the same schema output type and source/validation errors

### Requirement: Configuration can be consumed inside another Service

An Effect-returning method on a Service MUST be able to yield a schema-bound configuration directly. The resulting Service requirement and error metadata MUST remain visible at typed execution boundaries.

#### Scenario: A Service reads typed configuration

- **WHEN** a Service method yields a configuration whose schema outputs `{ databaseUrl: string; poolSize: number }`
- **THEN** the method MUST observe those exact types and a Runtime execution MUST preserve configuration errors in its Result
