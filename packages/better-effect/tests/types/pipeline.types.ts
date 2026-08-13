import { expectTypeOf } from 'bun:test'

import { Result } from 'better-result'

import {
  Effect,
  type EffectError,
  type EffectRequirements,
  type EffectResult,
  type EffectSuccess
} from '../../src/effect'
import { Runtime } from '../../src/runtime'
import { Service, type ServiceToken } from '../../src/service'
import { pipe } from '../../src/function'

class Database extends Service<Database>()('Database') {
  find(): string {
    return 'user'
  }
}

class Cache extends Service<Cache>()('Cache') {
  get(): string {
    return 'cached'
  }
}

class FirstFailure extends Error {}
class SecondFailure extends Error {}
class NormalizedFailure extends Error {
  readonly originalCause: unknown

  constructor(cause: unknown) {
    super('normalized')
    this.originalCause = cause
  }
}

const source = Effect.gen(async function* () {
  const database = yield* Database

  return Result.ok({ id: database.find() })
})

declare const sourceResult: Awaited<typeof source>
const directResultMap = Result.map(sourceResult, (user: { id: string }) => user.id)

// better-result's Result combinator intentionally returns a plain Result, so the
// Effect facade is the boundary that restores the phantom requirements.
expectTypeOf<EffectRequirements<typeof directResultMap>>().toEqualTypeOf<never>()

const mapped = pipe(
  source,
  Effect.map((user: { id: string }) => user.id)
)

expectTypeOf<EffectSuccess<typeof mapped>>().toEqualTypeOf<string>()
expectTypeOf<EffectError<typeof mapped>>().toEqualTypeOf<never>()
expectTypeOf<EffectRequirements<typeof mapped>>().toEqualTypeOf<
  ServiceToken<'Database', Database>
>()

// oxlint-disable-next-line require-yield
const syncSource = Effect.gen(function* () {
  return Result.ok('value')
})

const syncMapped = pipe(
  syncSource,
  Effect.map((value: string) => value.length)
)

expectTypeOf<EffectSuccess<typeof syncMapped>>().toEqualTypeOf<number>()
expectTypeOf<EffectError<typeof syncMapped>>().toEqualTypeOf<never>()
expectTypeOf<EffectRequirements<typeof syncMapped>>().toEqualTypeOf<never>()

const syncChained = pipe(
  syncSource,
  Effect.andThen((value: string) => Result.ok(value.length))
)

expectTypeOf<EffectSuccess<typeof syncChained>>().toEqualTypeOf<number>()
expectTypeOf<EffectError<typeof syncChained>>().toEqualTypeOf<never>()
expectTypeOf<EffectRequirements<typeof syncChained>>().toEqualTypeOf<never>()

const syncErrAsyncChained = Effect.andThenAsync(Result.err<number, string>('failed'), (value) =>
  Promise.resolve(Result.ok(value + 1))
)

expectTypeOf(syncErrAsyncChained).toEqualTypeOf<Promise<EffectResult<number, string, never>>>()

const invalidAsyncAndThen = Effect.andThen(Result.ok(1), (value) =>
  // @ts-expect-error `Effect.andThen` is the synchronous combinator.
  Promise.resolve(Result.ok(value + 1))
)

void invalidAsyncAndThen

const mappedDataFirst = Effect.map(source, (user: { id: string }) => user.id)

expectTypeOf<EffectSuccess<typeof mappedDataFirst>>().toEqualTypeOf<string>()
expectTypeOf<EffectError<typeof mappedDataFirst>>().toEqualTypeOf<never>()
expectTypeOf<EffectRequirements<typeof mappedDataFirst>>().toEqualTypeOf<
  ServiceToken<'Database', Database>
>()

const errorSource = Effect.gen(async function* () {
  if (Math.random() < 0) {
    yield* Result.err<never, FirstFailure>(new FirstFailure())
  }

  return Result.ok('value')
})

const mappedError = pipe(
  errorSource,
  Effect.mapError((cause: FirstFailure) => new NormalizedFailure(cause))
)

expectTypeOf<EffectSuccess<typeof mappedError>>().toEqualTypeOf<string>()
expectTypeOf<EffectError<typeof mappedError>>().toEqualTypeOf<NormalizedFailure>()
expectTypeOf<EffectRequirements<typeof mappedError>>().toEqualTypeOf<never>()

const mappedErrorDataFirst = Effect.mapError(
  errorSource,
  (cause: FirstFailure) => new NormalizedFailure(cause)
)

expectTypeOf<EffectSuccess<typeof mappedErrorDataFirst>>().toEqualTypeOf<string>()
expectTypeOf<EffectError<typeof mappedErrorDataFirst>>().toEqualTypeOf<NormalizedFailure>()
expectTypeOf<EffectRequirements<typeof mappedErrorDataFirst>>().toEqualTypeOf<never>()

const sourceWithErrorRequirement = Effect.gen(async function* () {
  yield* Database
  yield* Result.err<never, FirstFailure>(new FirstFailure())

  return Result.ok('value')
})

const mappedErrorWithRequirement = pipe(
  sourceWithErrorRequirement,
  Effect.mapError((cause: FirstFailure) => new NormalizedFailure(cause))
)

expectTypeOf<EffectRequirements<typeof mappedErrorWithRequirement>>().toEqualTypeOf<
  ServiceToken<'Database', Database>
>()

const chained = pipe(
  source,
  Effect.andThenAsync((user: { id: string }) =>
    Effect.gen(async function* () {
      const cache = yield* Cache

      if (Math.random() < 0) {
        yield* Result.err<never, SecondFailure>(new SecondFailure())
      }

      return Result.ok(`${user.id}:${cache.get()}`)
    })
  )
)

expectTypeOf<EffectSuccess<typeof chained>>().toEqualTypeOf<string>()
expectTypeOf<EffectError<typeof chained>>().toEqualTypeOf<SecondFailure>()
expectTypeOf<EffectRequirements<typeof chained>>().toEqualTypeOf<
  ServiceToken<'Database', Database> | ServiceToken<'Cache', Cache>
>()

const finalPipeline = pipe(
  chained,
  Effect.map((value: string) => value.length),
  Effect.mapError((cause: SecondFailure) => new NormalizedFailure(cause))
)

expectTypeOf<EffectSuccess<typeof finalPipeline>>().toEqualTypeOf<number>()
expectTypeOf<EffectError<typeof finalPipeline>>().toEqualTypeOf<NormalizedFailure>()
expectTypeOf<EffectRequirements<typeof finalPipeline>>().toEqualTypeOf<
  ServiceToken<'Database', Database> | ServiceToken<'Cache', Cache>
>()

const chainedDataFirst = Effect.andThenAsync(source, (user: { id: string }) =>
  Effect.gen(async function* () {
    const cache = yield* Cache

    return Result.ok(`${user.id}:${cache.get()}`)
  })
)

expectTypeOf<EffectSuccess<typeof chainedDataFirst>>().toEqualTypeOf<string>()
expectTypeOf<EffectRequirements<typeof chainedDataFirst>>().toEqualTypeOf<
  ServiceToken<'Database', Database> | ServiceToken<'Cache', Cache>
>()

const chainedErrors = pipe(
  errorSource,
  Effect.andThenAsync((value) => {
    void value

    return Effect.gen(async function* () {
      yield* Result.err<never, SecondFailure>(new SecondFailure())

      return Result.ok(true)
    })
  })
)

expectTypeOf<EffectError<typeof chainedErrors>>().toEqualTypeOf<FirstFailure | SecondFailure>()

const plainMapped = pipe(
  Result.ok(1),
  Effect.map((value: number) => value.toString())
)

expectTypeOf<EffectSuccess<typeof plainMapped>>().toEqualTypeOf<string>()
expectTypeOf<EffectError<typeof plainMapped>>().toEqualTypeOf<never>()
expectTypeOf<EffectRequirements<typeof plainMapped>>().toEqualTypeOf<never>()

const plainMappedError = pipe(
  Result.err<never, string>('failed'),
  Effect.mapError((error: string) => error.toUpperCase())
)

expectTypeOf<EffectSuccess<typeof plainMappedError>>().toEqualTypeOf<never>()
expectTypeOf<EffectError<typeof plainMappedError>>().toEqualTypeOf<string>()
expectTypeOf<EffectRequirements<typeof plainMappedError>>().toEqualTypeOf<never>()

const numberPipeline = pipe(
  1,
  (value) => value.toString(),
  (value) => value.length
)

expectTypeOf(numberPipeline).toEqualTypeOf<number>()

const databaseRuntime = {} as Runtime<typeof Database>
const completeRuntime = {} as Runtime<typeof Database | typeof Cache>

void completeRuntime.run(() => chained)

// @ts-expect-error The pipeline also requires Cache.
void databaseRuntime.run(() => chained)
