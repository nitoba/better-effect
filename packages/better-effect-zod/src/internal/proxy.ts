import { findDescriptor, registerDescriptor } from "./descriptor.js"
import { getClassCodec } from "./codec.js"

const schemaMethodCache = new WeakMap<Function, Map<PropertyKey, unknown>>()
const zodStateCache = new WeakMap<Function, object>()

type JSONSchemaContext = {
  readonly seen?: Map<unknown, unknown>
}

const seenOf = (context: unknown): Map<unknown, unknown> | undefined => {
  if (typeof context !== "object" || context === null) return undefined

  const seen = Reflect.get(context, "seen")
  return seen instanceof Map ? seen : undefined
}

const zodStateFor = (
  constructor: Function,
  codec: object
): object => {
  const cached = zodStateCache.get(constructor)
  if (cached !== undefined) return cached

  const state = Reflect.get(codec, "_zod", codec) as object
  const processor = Reflect.get(state, "processJSONSchema", state)
  if (typeof processor !== "function") {
    zodStateCache.set(constructor, state)
    return state
  }

  const facadeState = new Proxy(state, {
    get(current, property, receiver) {
      if (property !== "processJSONSchema") {
        return Reflect.get(current, property, receiver)
      }

      return (
        context: JSONSchemaContext,
        json: unknown,
        params: unknown
      ): unknown => {
        const seen = seenOf(context)
        const result = seen?.get(constructor)
        if (seen === undefined || result === undefined || seen.has(codec)) {
          return Reflect.apply(processor, state, [context, json, params])
        }

        seen.set(codec, result)
        try {
          return Reflect.apply(processor, state, [context, json, params])
        } finally {
          seen.delete(codec)
        }
      }
    }
  })

  zodStateCache.set(constructor, facadeState)
  return facadeState
}

const asSchemaConstructor = (
  receiver: unknown,
  fallback: Function
): Function => typeof receiver === "function" && findDescriptor(receiver) !== undefined
  ? receiver
  : fallback

const delegatedDescriptor = (
  codec: object,
  property: PropertyKey
): PropertyDescriptor | undefined => {
  let current: object | null = codec

  while (current !== null) {
    const descriptor = Reflect.getOwnPropertyDescriptor(current, property)
    if (descriptor !== undefined) {
      return { ...descriptor, configurable: true }
    }
    current = Reflect.getPrototypeOf(current)
  }

  return undefined
}

const delegatedValue = (
  constructor: Function,
  property: PropertyKey
): unknown => {
  let cached = schemaMethodCache.get(constructor)
  if (cached === undefined) {
    cached = new Map()
    schemaMethodCache.set(constructor, cached)
  }
  if (cached.has(property)) return cached.get(property)

  const codec = getClassCodec(constructor)
  if (property === "_zod") return zodStateFor(constructor, codec)

  const value = Reflect.get(codec, property, codec) as unknown
  if (typeof value !== "function") return value

  const delegated = value.bind(codec)
  cached.set(property, delegated)
  return delegated
}

const shouldPreferCodec = (
  target: Function,
  property: PropertyKey
): boolean => property === "apply" && !Object.prototype.hasOwnProperty.call(target, property)

/**
 * Adds the structural surface of a real Zod codec to a class constructor.
 * No Zod parser internals are reimplemented; every unknown property is read
 * from the concrete class codec.
 */
export const createSchemaFacade = <Constructor extends Function>(
  target: Constructor
): Constructor => {
  let proxy!: Constructor
  const handler: ProxyHandler<Constructor> = {
    get(current, property, receiver) {
      if (!shouldPreferCodec(current, property) && Reflect.has(current, property)) {
        return Reflect.get(current, property, receiver) as unknown
      }

      const constructor = asSchemaConstructor(receiver, proxy)
      return delegatedValue(constructor, property)
    },

    has(current, property) {
      return Reflect.has(current, property) || property in getClassCodec(proxy)
    },

    ownKeys(current) {
      return Array.from(new Set([
        ...Reflect.ownKeys(current),
        ...Reflect.ownKeys(getClassCodec(proxy))
      ]))
    },

    getOwnPropertyDescriptor(current, property): PropertyDescriptor | undefined {
      if (!shouldPreferCodec(current, property)) {
        const own = Reflect.getOwnPropertyDescriptor(current, property)
        if (own !== undefined) return own
      }
      return delegatedDescriptor(getClassCodec(proxy), property)
    }
  }

  proxy = new Proxy(target, handler) as Constructor

  const descriptor = findDescriptor(target)
  if (descriptor !== undefined) registerDescriptor(proxy, descriptor)

  return proxy
}
