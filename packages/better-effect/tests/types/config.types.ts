import { expectTypeOf } from 'bun:test'

import { Result, type StandardSchemaV1, type UnhandledException } from 'better-result'

import { Effect, Layer, Service, pipe } from '../../src'
import {
  Config,
  ConfigLive,
  ConfigValidationError,
  type ConfigError,
  type ConfigOutput
} from '../../src/standard-services'

type Settings = {
  readonly port: number
}

type SettingsSchemaTypes = {
  input: Record<string, string | undefined>
  output: Settings
}

const settingsSchema = {
  '~standard': {
    version: 1,
    vendor: 'better-effect-type-test',
    // SAFETY: Standard Schema uses this declaration-only carrier for exact output inference.
    types: {} as SettingsSchemaTypes,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters
    validate: (value: unknown): StandardSchemaV1.Result<Settings> => ({
      // SAFETY: The schema validates this boundary before using the environment fields.
      value: { port: Number((value as Record<string, string | undefined>).PORT) }
    })
  }
} satisfies StandardSchemaV1<Record<string, string | undefined>, Settings>

const bound = Config.fromEnv({ schema: settingsSchema, envSource: { PORT: '3000' } })
const boundProgram = Effect.fn(async function* () {
  const settings = yield* bound
  return Result.ok(settings)
})

expectTypeOf<ConfigOutput<typeof settingsSchema>>().toEqualTypeOf<Settings>()
expectTypeOf<Effect.Success<typeof boundProgram>>().toEqualTypeOf<Settings>()
expectTypeOf<Effect.Error<typeof boundProgram>>().toEqualTypeOf<ConfigError>()
expectTypeOf<Effect.Requirements<typeof boundProgram>>().toBeNever()

const provider = Config.schema(settingsSchema)
const providerProgram = Effect.fn(async function* () {
  const settings = yield* provider
  return Result.ok(settings)
})

expectTypeOf<Effect.Success<typeof providerProgram>>().toEqualTypeOf<Settings>()
expectTypeOf<Effect.Error<typeof providerProgram>>().toEqualTypeOf<ConfigError>()
expectTypeOf<Effect.Requirements<typeof providerProgram>>().toEqualTypeOf<Config>()

const composed = pipe(provider, Config.withEnv({ envSource: { PORT: '4000' } }))
const composedProgram = Effect.fn(async function* () {
  return Result.ok(yield* composed)
})

expectTypeOf<Effect.Success<typeof composedProgram>>().toEqualTypeOf<Settings>()
expectTypeOf<Effect.Error<typeof composedProgram>>().toEqualTypeOf<ConfigError>()
expectTypeOf<Effect.Requirements<typeof composedProgram>>().toEqualTypeOf<Config>()
expectTypeOf<Layer.Provided<typeof ConfigLive>>().toEqualTypeOf<Config>()

class SettingsService extends Service<SettingsService>()('SettingsService') {
  read() {
    return Effect.fn(async function* () {
      return Result.ok(yield* Config.schema(settingsSchema))
    })
  }
}

expectTypeOf<Service.Requirements<SettingsService>>().toEqualTypeOf<Config>()

expectTypeOf<ConfigValidationError>().toMatchTypeOf<Error>()
expectTypeOf<UnhandledException>().toMatchTypeOf<Error>()
