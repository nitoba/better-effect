import { expect, expectTypeOf, test } from 'bun:test'
import { rm } from 'node:fs/promises'

import {
  Result,
  type Result as ResultType,
  type StandardSchemaV1,
  UnhandledException
} from 'better-result'

import { Effect, Layer, Runtime, ServiceNotFoundError, ServiceRuntime } from '../src'
import {
  Clock,
  ClockTest,
  Config,
  ConfigSourceError,
  ConfigValidationError,
  CurrentAbortSignal,
  CurrentRequest,
  Logger,
  LoggerTest,
  Random,
  RandomSeeded
} from '../src/standard-services'

type AppConfig = {
  readonly port: number
  readonly name: string
}

type AppSchemaTypes = {
  input: Record<string, string | undefined>
  output: AppConfig
}

type SourceSchemaOutput = {
  readonly port: string
  readonly empty: string
}

type SourceSchemaTypes = {
  input: Record<string, string | undefined>
  output: SourceSchemaOutput
}

const appSchema = {
  '~standard': {
    version: 1,
    vendor: 'better-effect-test',
    // SAFETY: Standard Schema uses this declaration-only carrier for exact output inference.
    types: {} as AppSchemaTypes,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters
    validate(value: unknown): StandardSchemaV1.Result<AppConfig> {
      // SAFETY: The schema validates this boundary before using the environment fields.
      const source = value as Record<string, string | undefined>
      const port = Number(source.PORT)

      if (!Number.isInteger(port) || port <= 0) {
        return {
          issues: [{ message: 'PORT must be a positive integer', path: ['PORT'] }]
        }
      }

      return { value: { port, name: source.APP_NAME ?? 'default' } }
    }
  }
} satisfies StandardSchemaV1<Record<string, string | undefined>, AppConfig>

const expectResult = (result: ResultType<any, any>, expected: ResultType<any, any>) =>
  expect(result).toEqual(expected)

test('ClockTest controls time and pending waits', async () => {
  const clock = new ClockTest(new Date('2025-01-01T00:00:00.000Z'))
  let completed = false
  const waiting = clock.sleep(100).then(() => {
    completed = true
  })

  await Promise.resolve()
  expect(completed).toBe(false)
  clock.advance(100)
  await waiting
  expect(completed).toBe(true)
  expect(clock.now()).toEqual(new Date('2025-01-01T00:00:00.100Z'))

  const runtime = await Runtime.make(ClockTest.layer(new Date('2025-01-01T00:00:00.000Z')))
  try {
    const observed = await runtime.run(
      Effect.fn(async function* () {
        const current = yield* Clock
        return Result.ok(current.now())
      })
    )
    expectResult(observed, Result.ok(new Date('2025-01-01T00:00:00.000Z')))
  } finally {
    await runtime.dispose()
  }
})

test('RandomSeeded repeats sequences without shared state', () => {
  const first = new RandomSeeded(42)
  const second = new RandomSeeded(42)

  expect([first.next(), first.next(), first.nextInt(10)]).toEqual([
    second.next(),
    second.next(),
    second.nextInt(10)
  ])
  expect(new Random().next()).toBeGreaterThanOrEqual(0)
})

test('LoggerTest captures structured events in order', () => {
  const logger = new LoggerTest()

  logger.info('started', { requestId: 'r1' })
  logger.error('failed')

  expect(logger.events).toEqual([
    { level: 'info', message: 'started', data: { requestId: 'r1' } },
    { level: 'error', message: 'failed' }
  ])
  expect(new Logger()).toBeInstanceOf(Logger)
})

test('CurrentRequest and CurrentAbortSignal remain execution-local', async () => {
  const runtime = await Runtime.make(Layer.merge())
  const requestProgram = Effect.fn(async function* () {
    const request = yield* CurrentRequest
    const signal = yield* CurrentAbortSignal
    return Result.ok({ value: request.value, aborted: signal.aborted })
  })

  try {
    const [first, second] = await Promise.all([
      runtime.runWith(CurrentRequest.layer('first'), requestProgram),
      runtime.runWith(CurrentRequest.layer('second'), requestProgram)
    ])

    expectResult(first, Result.ok({ value: 'first', aborted: false }))
    expectResult(second, Result.ok({ value: 'second', aborted: false }))
  } finally {
    await runtime.dispose()
  }
})

test('Config.fromEnv validates transformed values and can be reused', async () => {
  const appConfig = Config.fromEnv({
    schema: appSchema,
    envSource: { PORT: '3000', APP_NAME: 'test' }
  })

  const read = () =>
    Effect.gen(async function* () {
      const value = yield* appConfig
      return Result.ok(value)
    })

  const first = await read()
  const second = await read()

  expectResult(first, Result.ok({ port: 3000, name: 'test' }))
  expectResult(second, Result.ok({ port: 3000, name: 'test' }))
  if (Result.isOk(first)) {
    expectTypeOf(first.value).toEqualTypeOf<AppConfig>()
  }
})

test('Config supports asynchronous validation and typed validation failures', async () => {
  const asyncSchema = {
    '~standard': {
      ...appSchema['~standard'],
      // oxlint-disable-next-line anti-slop/no-unknown-parameters
      validate: async (value: unknown) => appSchema['~standard'].validate(value)
    }
  } satisfies StandardSchemaV1<Record<string, string | undefined>, AppConfig>

  const success = await Effect.gen(async function* () {
    const value = yield* Config.fromEnv({
      schema: asyncSchema,
      envSource: { PORT: '8080', APP_NAME: 'async' }
    })

    return Result.ok(value)
  })

  const failure = await Effect.gen(async function* () {
    const value = yield* Config.fromEnv({
      schema: appSchema,
      envSource: { PORT: 'nope', SECRET: 'do-not-report' }
    })

    return Result.ok(value)
  })

  expectResult(success, Result.ok({ port: 8080, name: 'async' }))
  expect(Result.isError(failure)).toBe(true)
  if (Result.isError(failure)) {
    expect(failure.error).toBeInstanceOf(ConfigValidationError)
    expect(JSON.stringify(failure.error)).not.toContain('do-not-report')
  }

  const throws = await Effect.gen(async function* () {
    const value = yield* Config.fromEnv({
      schema: {
        '~standard': {
          version: 1,
          vendor: 'better-effect-throw-test',
          // SAFETY: Standard Schema uses this declaration-only carrier for exact output inference.
          types: {} as AppSchemaTypes,
          validate: () => {
            throw new Error('validator failed')
          }
        }
      } satisfies StandardSchemaV1<Record<string, string | undefined>, AppConfig>,
      envSource: { PORT: '1' }
    })

    return Result.ok(value)
  })

  expect(Result.isError(throws)).toBe(true)
  if (Result.isError(throws)) {
    expect(throws.error).toBeInstanceOf(UnhandledException)
  }
})

test('Config provider Layers are explicit and replaceable', async () => {
  const program = Effect.fn(async function* () {
    return Result.ok(yield* Config.schema(appSchema))
  })

  const runtime = await Runtime.make(
    Config.layerFromEnv({ envSource: { PORT: '3000', APP_NAME: 'base' } })
  )
  const overridden = await Runtime.make(
    Layer.override(
      Config.layer({ PORT: '3000', APP_NAME: 'base' }),
      Config.layer({ PORT: '4000', APP_NAME: 'test' })
    )
  )

  try {
    expectResult(await runtime.run(program), Result.ok({ port: 3000, name: 'base' }))
    expectResult(await overridden.run(program), Result.ok({ port: 4000, name: 'test' }))
  } finally {
    await runtime.dispose()
    await overridden.dispose()
  }
})

test('Config.schema does not install a hidden source provider', async () => {
  // SAFETY: This test intentionally erases the empty Layer to exercise the unchecked boundary.
  const runtime = await Runtime.make(Layer.merge() as Layer.Any)

  try {
    expect(runtime.run(() => ServiceRuntime.resolve(Config))).rejects.toBeInstanceOf(
      ServiceNotFoundError
    )
  } finally {
    await runtime.dispose()
  }
})

test('Config.fromEnv reports dotenv source failures without raw values', async () => {
  const result = await Effect.gen(async function* () {
    const value = yield* Config.fromEnv({
      schema: appSchema,
      dotEnvPath: '/tmp/better-effect-config-does-not-exist'
    })

    return Result.ok(value)
  })

  expect(Result.isError(result)).toBe(true)
  if (Result.isError(result)) {
    expect(result.error).toBeInstanceOf(ConfigSourceError)
    expect(JSON.stringify(result.error)).not.toContain('PORT')
  }
})

test('Config.fromEnv reads the host environment when no source is supplied', async () => {
  const previous = process.env.PORT
  process.env.PORT = '5050'

  try {
    const result = await Effect.gen(async function* () {
      const value = yield* Config.fromEnv({ schema: appSchema })
      return Result.ok(value)
    })

    expectResult(result, Result.ok({ port: 5050, name: 'default' }))
  } finally {
    if (previous === undefined) {
      delete process.env.PORT
    } else {
      process.env.PORT = previous
    }
  }
})

test('Config.fromEnv reports malformed dotenv files as source errors', async () => {
  const dotEnvPath = '/tmp/better-effect-config-malformed.env'
  await Bun.write(dotEnvPath, 'NOT_A_CONFIG_LINE\n')

  try {
    const result = await Effect.gen(async function* () {
      const value = yield* Config.fromEnv({ schema: appSchema, dotEnvPath })
      return Result.ok(value)
    })

    expect(Result.isError(result)).toBe(true)
    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(ConfigSourceError)
    }
  } finally {
    await rm(dotEnvPath, { force: true })
  }
})

test('Config sources preserve raw strings and explicit environment precedence', async () => {
  const dotEnvPath = '/tmp/better-effect-config-precedence.env'

  await Bun.write(dotEnvPath, 'PORT=3000\nAPP_NAME="from dotenv"\nEMPTY=\nexport EXTRA=quoted\n')

  try {
    const schema = {
      '~standard': {
        version: 1,
        vendor: 'better-effect-source-test',
        // SAFETY: Standard Schema uses this declaration-only carrier for exact output inference.
        types: {} as SourceSchemaTypes,
        // oxlint-disable-next-line anti-slop/no-unknown-parameters
        validate(value: unknown) {
          // SAFETY: The schema validates this boundary before using the environment fields.
          const source = value as Record<string, string | undefined>

          return {
            value: {
              port: source.PORT ?? '',
              empty: source.EMPTY ?? 'missing'
            }
          }
        }
      }
    } satisfies StandardSchemaV1<
      Record<string, string | undefined>,
      { readonly port: string; readonly empty: string }
    >

    const result = await Effect.gen(async function* () {
      const value = yield* Config.fromEnv({
        schema,
        dotEnvPath,
        envSource: { PORT: '4000', EMPTY: '' }
      })

      return Result.ok(value)
    })

    expectResult(result, Result.ok({ port: '4000', empty: '' }))
  } finally {
    await rm(dotEnvPath, { force: true })
  }
})

void LoggerTest.layer
