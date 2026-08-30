import type { UnhandledException } from 'better-result'

import type { BetterAuthApiError } from '../errors'
import type {
  BetterAuthEffectApi,
  BetterAuthOperation,
  BetterAuthTransportFlag
} from '../effect-api'

import { fromBetterAuthPromise } from './from-better-auth-promise'

type TransportMode = 'data' | 'response' | 'headers'
type RuntimeArguments = readonly unknown[]
type RuntimeEndpoint = (this: object, ...args: RuntimeArguments) => PromiseLike<unknown>
type RuntimeOperation<Code extends string> = (
  ...args: RuntimeArguments
) => BetterAuthOperation<unknown, BetterAuthApiError<Code> | UnhandledException>
type RuntimeEffectEndpoint<Code extends string> = RuntimeOperation<Code> & {
  readonly asResponse: RuntimeOperation<Code>
  readonly withHeaders: RuntimeOperation<Code>
}

type TransportSelection = {
  readonly asResponse: boolean
  readonly returnHeaders: boolean
  readonly returnStatus: false
}

const transportSelection = (mode: TransportMode): TransportSelection => ({
  asResponse: mode === 'response',
  returnHeaders: mode === 'headers',
  returnStatus: false
})

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Transport flags are inspected at the untyped JavaScript call boundary before reaching Better Auth.
const assertCompatibleFlag = (
  value: unknown,
  expected: boolean,
  flag: BetterAuthTransportFlag,
  mode: TransportMode
): void => {
  if (value === undefined || value === false || (value === true && expected)) {
    return
  }

  throw new TypeError(
    `Better Auth transport flag "${flag}" conflicts with the "${mode}" effectful mode`
  )
}

const normalizeArguments = (args: RuntimeArguments, mode: TransportMode): RuntimeArguments => {
  const first = args[0]

  if (first !== undefined && (first === null || Object(first) !== first)) {
    throw new TypeError('Better Auth endpoint context must be an object when provided')
  }

  // SAFETY: the object check above establishes the only shape needed here; individual transport fields remain unknown until validated.
  const context = (first ?? {}) as Readonly<Record<string, unknown>>
  const selection = transportSelection(mode)

  assertCompatibleFlag(context.asResponse, selection.asResponse, 'asResponse', mode)
  assertCompatibleFlag(context.returnHeaders, selection.returnHeaders, 'returnHeaders', mode)
  assertCompatibleFlag(context.returnStatus, false, 'returnStatus', mode)

  const normalizedContext = {
    ...context,
    ...selection
  }

  return [normalizedContext, ...args.slice(1)]
}

const makeOperation =
  <Code extends string>(
    target: object,
    endpoint: RuntimeEndpoint,
    mode: TransportMode
  ): RuntimeOperation<Code> =>
  (...args) =>
    fromBetterAuthPromise(() => endpoint.call(target, ...normalizeArguments(args, mode)))

const makeEndpoint = <Code extends string>(
  target: object,
  endpoint: RuntimeEndpoint
): RuntimeEffectEndpoint<Code> => {
  const operation = makeOperation<Code>(target, endpoint, 'data')

  Object.defineProperties(operation, {
    asResponse: {
      value: makeOperation<Code>(target, endpoint, 'response'),
      enumerable: false,
      configurable: false,
      writable: false
    },
    withHeaders: {
      value: makeOperation<Code>(target, endpoint, 'headers'),
      enumerable: false,
      configurable: false,
      writable: false
    }
  })

  // SAFETY: both readonly transport functions were defined above on this exact operation.
  return operation as RuntimeEffectEndpoint<Code>
}

/** Build one cached Proxy over the concrete Better Auth server API. */
export function makeBetterAuthEffectApi<Api extends object, Code extends string>(
  rawApi: Api
): BetterAuthEffectApi<Api, Code> {
  const cache = new Map<PropertyKey, RuntimeEffectEndpoint<Code>>()

  const effectApi = new Proxy(rawApi, {
    get(target, key) {
      const cached = cache.get(key)
      if (cached !== undefined) {
        return cached
      }

      if (!Object.prototype.hasOwnProperty.call(target, key)) {
        return undefined
      }

      // oxlint-disable-next-line anti-slop/no-reflect-get -- A Proxy must inspect the property selected by its PropertyKey without assuming a string-only API.
      const candidate = Reflect.get(target, key)
      if (!(candidate instanceof Function)) {
        return undefined
      }

      // SAFETY: the callable check above establishes the runtime endpoint boundary; Better Auth server endpoints return Promise-like values.
      const endpoint = candidate as RuntimeEndpoint
      const adapted = makeEndpoint<Code>(target, endpoint)
      cache.set(key, adapted)
      return adapted
    }
  })

  // SAFETY: the Proxy maps every callable own member lazily to the public effectful endpoint contract and hides all other members.
  return effectApi as BetterAuthEffectApi<Api, Code>
}
