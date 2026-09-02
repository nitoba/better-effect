import {
  Result,
  TaggedError,
  type Err,
  type Result as ResultType,
  type StandardSchemaV1,
  type UnhandledException
} from 'better-result'

import type { ServiceRequirement } from '../effect/types'
import { Layer } from '../layer'
import { Service } from '../service'

/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- schema output is opaque at this generic runtime boundary and is narrowed before storage. */

/** Raw string values supplied to a configuration schema. */
export type ConfigSource = Readonly<Record<string, string | undefined>>

/** Optional sources used by environment-backed configuration values. */
export type ConfigSourceOptions = {
  readonly dotEnvPath?: string
  readonly envSource?: ConfigSource
}

/** Options for the one-call schema-bound configuration API. */
export type ConfigFromEnvOptions<Schema extends StandardSchemaV1> = ConfigSourceOptions & {
  readonly schema: Schema
}

/** The decoded value produced by a Standard Schema. */
export type ConfigOutput<Schema extends StandardSchemaV1> = StandardSchemaV1.InferOutput<Schema>

/** The raw input type described by a Standard Schema. */
export type ConfigInput<Schema extends StandardSchemaV1> = StandardSchemaV1.InferInput<Schema>

/** The string keys exposed by a schema's decoded configuration output. */
type ConfigOutputObject<Schema extends StandardSchemaV1> =
  ConfigOutput<Schema> extends object ? ConfigOutput<Schema> : Record<never, never>

export type ConfigKey<Schema extends StandardSchemaV1> = Extract<
  keyof ConfigOutputObject<Schema>,
  string
>

/** A safe validation issue exposed by a configuration failure. */
export type ConfigIssue = StandardSchemaV1.Issue

/** A schema validation failure. Raw source values are intentionally omitted. */
export class ConfigValidationError extends TaggedError('ConfigValidationError')<{
  readonly issues: ReadonlyArray<ConfigIssue>
  readonly message: string
}> {}

/** A dotenv or host-source loading failure. Raw source values are intentionally omitted. */
export class ConfigSourceError extends TaggedError('ConfigSourceError')<{
  readonly cause: unknown
  readonly message: string
  readonly path?: string
}> {}

/** Errors that may be returned while loading or validating configuration. */
export type ConfigError = ConfigValidationError | ConfigSourceError | UnhandledException

type ConfigYield<Requirements extends Service.Any, Error> =
  | Err<never, Error>
  | ServiceRequirement<Requirements>

/** A reusable, async-yieldable Standard Schema configuration descriptor. */
export type ConfigValue<
  Schema extends StandardSchemaV1,
  Requirements extends Service.Any = never,
  Error = ConfigError
> = {
  [Symbol.asyncIterator](): AsyncGenerator<
    ConfigYield<Requirements, Error>,
    ConfigOutput<Schema>,
    unknown
  >
}

type RuntimeConfigYield = Err<never, ConfigError> | ServiceRequirement<Service.Any>

type ConfigValueSpec<Schema extends StandardSchemaV1> = {
  readonly schema: Schema
  readonly source: 'bound' | 'provider'
  readonly sourceOptions?: ConfigSourceOptions
}

type MutableConfigSourceOptions = {
  dotEnvPath?: string
  envSource?: ConfigSource
}

type RuntimeGlobal = typeof globalThis & {
  readonly process?: { readonly env?: ConfigSource }
  readonly Bun?: {
    readonly env?: ConfigSource
    readonly file?: (path: string) => { text(): Promise<string> }
  }
}

// SAFETY: Hosts may expose process/Bun globals at runtime without declaring them on globalThis.
const runtimeGlobal = globalThis as RuntimeGlobal

const hostEnvironment = (): ConfigSource => {
  const processEnvironment = runtimeGlobal.process?.env

  if (processEnvironment !== undefined) {
    return processEnvironment
  }

  return runtimeGlobal.Bun?.env ?? {}
}

const readText = async (path: string): Promise<string> => {
  const file = runtimeGlobal.Bun?.file

  if (file !== undefined) {
    return await file(path).text()
  }

  const { readFile } = await import('node:fs/promises')

  return await readFile(path, 'utf8')
}

const parseDotEnv = (text: string) => {
  const values = new Map<string, string>()

  for (const [lineIndex, rawLine] of text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/u)
    .entries()) {
    let line = rawLine.trim()

    if (line === '' || line.startsWith('#')) {
      continue
    }

    if (/^export\s/u.test(line)) {
      line = line.replace(/^export\s+/u, '')
    }

    const separator = line.indexOf('=')

    if (separator <= 0) {
      throw new Error(`Invalid dotenv entry at line ${lineIndex + 1}`)
    }

    const key = line.slice(0, separator).trim()

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      throw new Error(`Invalid dotenv key at line ${lineIndex + 1}`)
    }

    let value = line.slice(separator + 1).trim()
    const quote = value[0]

    if (quote === '"' || quote === "'") {
      const closingQuote = value.indexOf(quote, 1)
      const trailing = closingQuote < 0 ? '' : value.slice(closingQuote + 1).trim()

      if (closingQuote < 0 || (trailing !== '' && !trailing.startsWith('#'))) {
        throw new Error(`Unterminated dotenv value at line ${lineIndex + 1}`)
      }

      value = value.slice(1, closingQuote)
    } else {
      const comment = value.search(/\s+#/u)

      if (comment >= 0) {
        value = value.slice(0, comment).trimEnd()
      }
    }

    values.set(key, value)
  }

  return Object.fromEntries(values)
}

const loadSource = async (options: ConfigSourceOptions = {}): Promise<ConfigSource> => {
  const dotenv =
    options.dotEnvPath === undefined ? {} : parseDotEnv(await readText(options.dotEnvPath))
  const explicit = options.envSource ?? hostEnvironment()

  return {
    ...dotenv,
    ...explicit
  }
}

const sourceError = (path: string | undefined, cause: unknown): ConfigSourceError => {
  const message =
    path === undefined
      ? 'Failed to load configuration source'
      : `Failed to load configuration source at ${path}`

  if (path === undefined) {
    return new ConfigSourceError({ cause, message })
  }

  return new ConfigSourceError({ cause, message, path })
}

const validate = async <Schema extends StandardSchemaV1>(
  schema: Schema,
  source: ConfigSource
): Promise<ResultType<ConfigOutput<Schema>, ConfigValidationError | UnhandledException>> => {
  const checked = await Result.tryPromise(() =>
    Promise.resolve(schema['~standard'].validate(source))
  )

  if (checked.status === 'error') {
    return checked
  }

  if (checked.value.issues !== undefined) {
    return Result.err(
      new ConfigValidationError({
        issues: Object.freeze([...checked.value.issues]),
        message: 'Configuration validation failed'
      })
    )
  }

  // SAFETY: A successful Standard Schema result carries its declared output type.
  return Result.ok(checked.value.value as ConfigOutput<Schema>)
}

const evaluate = async <Schema extends StandardSchemaV1>(
  spec: ConfigValueSpec<Schema>,
  provider?: Config
): Promise<ResultType<ConfigOutput<Schema>, ConfigError>> => {
  const loaded = await Result.tryPromise({
    try: async () => {
      if (spec.source === 'provider') {
        const base = provider?.source

        if (base === undefined) {
          throw new Error('Config provider did not expose a source')
        }

        if (spec.sourceOptions === undefined) {
          return base
        }

        return {
          ...base,
          ...(await loadSource(spec.sourceOptions))
        }
      }

      return await loadSource(spec.sourceOptions)
    },
    catch: (cause) => sourceError(spec.sourceOptions?.dotEnvPath, cause)
  })

  if (loaded.status === 'error') {
    return loaded
  }

  return await validate(spec.schema, loaded.value)
}

const makeConfigValue = <Schema extends StandardSchemaV1, Requirements extends Service.Any>(
  spec: ConfigValueSpec<Schema>
): ConfigValue<Schema, Requirements> => {
  const value = {
    ...spec,
    async *[Symbol.asyncIterator](): AsyncGenerator<
      RuntimeConfigYield,
      ConfigOutput<Schema>,
      unknown
    > {
      let provider: Config | undefined

      if (spec.source === 'provider') {
        provider = yield* Config
      }

      return yield* Result.await(evaluate(spec, provider))
    }
  }

  // SAFETY: The runtime iterator only yields Result errors and Service values; the public cast restores the phantom requirement.
  return value as ConfigValue<Schema, Requirements>
}

type ConfigWithOutput<Schema extends StandardSchemaV1> = Omit<Config, 'get'> & {
  get<Key extends ConfigKey<Schema>>(key: Key): ConfigOutputObject<Schema>[Key]
}

type SchemaConfigToken<Schema extends StandardSchemaV1> = Service.Class<
  'Config',
  ConfigWithOutput<Schema>
> &
  Service.Token<'Config', ConfigWithOutput<Schema>> & {
    readonly [Symbol.asyncIterator]: () => AsyncGenerator<
      ServiceRequirement<ConfigWithOutput<Schema>>,
      ConfigWithOutput<Schema>,
      unknown
    >
  } & {
    readonly layer: (source: ConfigSource) => Layer<ConfigWithOutput<Schema>, never>
    readonly layerFromEnv: (options?: ConfigSourceOptions) => Layer<ConfigWithOutput<Schema>, never>
  }

/** Host-backed raw configuration source and provider token. */
export class Config extends Service<Config>()('Config') {
  private values: Readonly<Record<string, unknown>>

  constructor(readonly source: ConfigSource) {
    super()
    this.values = source
  }

  /** Read one value from the configured source or decoded schema output. */
  get(key: string): string | undefined {
    // SAFETY: The unbound Config API contains raw string values; schema-bound tokens
    // narrow this method to their decoded output type.
    return this.values[key] as string | undefined
  }

  /**
   * Create a schema-bound Config token with a typed `get` accessor.
   *
   * The token validates its source while its Layer is acquired. The accessor then
   * reads the decoded schema output, so its return type follows the selected key.
   */
  static withSchema<Schema extends StandardSchemaV1>(schema: Schema): SchemaConfigToken<Schema> {
    class SchemaConfig extends Config {}

    // SAFETY: SchemaConfig is a Config subclass; this cast adds only schema-derived static signatures.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions
    const token = SchemaConfig as unknown as SchemaConfigToken<Schema>
    const acquire = async (source: ConfigSource): Promise<ConfigWithOutput<Schema>> => {
      const checked = await validate(schema, source)

      if (checked.status === 'error') {
        throw checked.error
      }

      const values = checked.value

      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Schema outputs must be objects for keyed access.
      if (typeof values !== 'object' || values === null) {
        throw new TypeError('Config schema output must be an object to use Config.get')
      }

      // SAFETY: Standard Schema returned a non-null object; this cast stores it behind the schema-derived Config.get type.
      const config = new Config(source)
      // SAFETY: The preceding object check establishes the runtime shape retained by Config.
      config.values = values as Readonly<Record<string, unknown>>
      // SAFETY: The validated output and schema key mapping establish this typed accessor.
      return config as ConfigWithOutput<Schema>
    }

    Object.assign(SchemaConfig, {
      layer: (source: ConfigSource) => Layer.make(token, () => acquire(source)),
      layerFromEnv: (options: ConfigSourceOptions = {}) =>
        Layer.make(token, async () => {
          const loaded = await Result.tryPromise({
            try: () => loadSource(options),
            catch: (cause) => sourceError(options.dotEnvPath, cause)
          })

          if (loaded.status === 'error') {
            throw loaded.error
          }

          return await acquire(loaded.value)
        })
    })

    return token
  }

  /** Create a provider from an already-loaded source. */
  static layer(source: ConfigSource) {
    return Layer.succeed(Config, new Config(source))
  }

  /** Create a provider whose source is loaded from dotenv and the host environment. */
  static layerFromEnv(options: ConfigSourceOptions = {}) {
    return Layer.make(Config, async () => {
      try {
        return new Config(await loadSource(options))
      } catch (cause) {
        throw sourceError(options.dotEnvPath, cause)
      }
    })
  }

  /** Describe a configuration read from the contextual Config provider. */
  static schema<Schema extends StandardSchemaV1>(schema: Schema): ConfigValue<Schema, Config> {
    return makeConfigValue({ schema, source: 'provider' })
  }

  /** Describe a reusable configuration loaded from dotenv and the host environment. */
  static fromEnv<Schema extends StandardSchemaV1>(
    options: ConfigFromEnvOptions<Schema>
  ): ConfigValue<Schema> {
    const sourceOptions: MutableConfigSourceOptions = {}

    if (options.dotEnvPath !== undefined) {
      sourceOptions.dotEnvPath = options.dotEnvPath
    }

    if (options.envSource !== undefined) {
      sourceOptions.envSource = options.envSource
    }

    return makeConfigValue({
      schema: options.schema,
      source: 'bound',
      sourceOptions
    })
  }

  /** Add an environment source to a provider-backed descriptor for functional `pipe` composition. */
  static withEnv(options: ConfigSourceOptions) {
    return <Schema extends StandardSchemaV1, Requirements extends Service.Any, Error = ConfigError>(
      value: ConfigValue<Schema, Requirements, Error>
    ): ConfigValue<Schema, Requirements, Error> => {
      // SAFETY: Values produced by this module retain their schema/source descriptor fields; custom iterables pass through unchanged.
      const internal = value as ConfigValue<Schema, Requirements> & ConfigValueSpec<Schema>

      if (!('schema' in internal)) {
        return value
      }

      // SAFETY: The internal descriptor preserves the original schema and requirement phantom.
      return makeConfigValue({
        schema: internal.schema,
        source: internal.source,
        sourceOptions: options
      }) as ConfigValue<Schema, Requirements, Error>
    }
  }
}

/** The default lazy host-environment Config provider. */
export const ConfigLive = Config.layerFromEnv()

export type { StandardSchemaV1 }
