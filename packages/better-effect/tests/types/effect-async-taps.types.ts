import { expectTypeOf } from 'bun:test'

import { Result, TaggedError, type Result as ResultType } from 'better-result'

import {
  Effect,
  type Effect as EffectType,
  type EffectError,
  type EffectRequirements
} from '../../src/effect'
import { Service } from '../../src/service'
import { pipe } from '../../src/function'

class Database extends Service<Database>()('AsyncTapDatabase') {
  record(value: number): Promise<void> {
    return Promise.resolve(value).then(() => undefined)
  }
}

class UserNotFound extends TaggedError('UserNotFound')<{
  readonly id: string
  readonly message: string
}> {}

class AccessDenied extends TaggedError('AccessDenied')<{
  readonly reason: string
  readonly message: string
}> {}

class HttpNotFound extends TaggedError('HttpNotFound')<{
  readonly message: string
}> {}

class HttpForbidden extends TaggedError('HttpForbidden')<{
  readonly message: string
}> {}

class HttpBadRequest extends TaggedError('HttpBadRequest')<{
  readonly message: string
}> {}

declare const effect: EffectType<number, UserNotFound | AccessDenied, Database>
declare const asyncEffect: Promise<EffectType<number, UserNotFound | AccessDenied, Database>>

type Expected = EffectType<number, UserNotFound | AccessDenied, Database>

const tapped = Effect.tapAsync(effect, async (value) => {
  void value
})
expectTypeOf(tapped).toEqualTypeOf<Promise<Expected>>()

const tappedError = Effect.tapErrorAsync(effect, async (error) => {
  void error
})
expectTypeOf(tappedError).toEqualTypeOf<Promise<Expected>>()

const tappedBoth = Effect.tapBothAsync(effect, {
  ok: async (value) => void value,
  err: async (error) => void error
})
expectTypeOf(tappedBoth).toEqualTypeOf<Promise<Expected>>()

const tappedPromise = Effect.tapAsync(asyncEffect, (value) => Promise.resolve(value).then(() => {}))
expectTypeOf(tappedPromise).toEqualTypeOf<Promise<Expected>>()

const pipedTap = Effect.tapAsync((value: number) => Promise.resolve(value).then(() => undefined))
expectTypeOf(pipedTap(effect)).toEqualTypeOf<Promise<Expected>>()
expectTypeOf(
  pipe(
    effect,
    Effect.tapAsync((value) => Promise.resolve(value).then(() => undefined))
  )
).toEqualTypeOf<Promise<Expected>>()

// @ts-expect-error async observers return PromiseLike<void>, not another Effect
void Effect.tapAsync(effect, () => Promise.resolve(Result.ok('not-an-observer')))

const mappedErrors = Effect.matchError(effect, {
  UserNotFound: (error) => new HttpNotFound({ message: error.message }),
  AccessDenied: (error) => new HttpForbidden({ message: error.reason })
})
expectTypeOf(mappedErrors).toEqualTypeOf<
  EffectType<number, HttpNotFound | HttpForbidden, Database>
>()

// @ts-expect-error every tagged error variant must be handled
Effect.matchError(effect, {
  UserNotFound: (error) => new HttpNotFound({ message: error.message })
})

const untaggedEffect = Result.err<number, string>('not-tagged')
// @ts-expect-error tagged-error matching is only supported for better-result tagged errors
Effect.matchError(untaggedEffect, {})
// @ts-expect-error tagged-error matching is only supported for better-result tagged errors
Effect.matchErrorPartial(untaggedEffect, {})

const partiallyMappedErrors = Effect.matchErrorPartial(effect, {
  UserNotFound: (error) => new HttpNotFound({ message: error.message })
})
expectTypeOf(partiallyMappedErrors).toEqualTypeOf<
  EffectType<number, HttpNotFound | AccessDenied, Database>
>()

const fullyMappedPartialErrors = Effect.matchErrorPartial(effect, {
  UserNotFound: (error) => new HttpNotFound({ message: error.message }),
  AccessDenied: (error) => new HttpBadRequest({ message: error.reason })
})
expectTypeOf(fullyMappedPartialErrors).toEqualTypeOf<
  EffectType<number, HttpNotFound | HttpBadRequest, Database>
>()

const asyncMappedErrors = Effect.matchError(asyncEffect, {
  UserNotFound: (error) => new HttpNotFound({ message: error.message }),
  AccessDenied: (error) => new HttpForbidden({ message: error.reason })
})
expectTypeOf(asyncMappedErrors).toEqualTypeOf<
  Promise<EffectType<number, HttpNotFound | HttpForbidden, Database>>
>()

expectTypeOf<EffectError<typeof mappedErrors>>().toEqualTypeOf<HttpNotFound | HttpForbidden>()
expectTypeOf<EffectRequirements<typeof mappedErrors>>().toEqualTypeOf<Database>()

const resultValue: ResultType<number, UserNotFound | AccessDenied> = Result.err(
  new AccessDenied({ reason: 'policy', message: 'Access denied' })
)
const resultTap = Effect.tapErrorAsync(resultValue, async (error) => {
  void error
})
expectTypeOf(resultTap).toEqualTypeOf<Promise<EffectType<number, UserNotFound | AccessDenied>>>()

void new Database()
void resultTap
