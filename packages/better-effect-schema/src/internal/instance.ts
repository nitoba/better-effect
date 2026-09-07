import * as z from "zod"

import { BetterEffectZodError } from "../errors.js"
import type { ClassKind } from "../types.js"
import { INSTANCE_MARKER } from "./symbols.js"

export interface InstanceMarker {
  readonly identifier: string
  readonly kind: ClassKind
}

export const asConstructionRecord = (value: unknown): Record<PropertyKey, unknown> => {
  if (value === undefined) return {}
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<PropertyKey, unknown>
  }

  throw new BetterEffectZodError(
    "INVALID_CONSTRUCTION",
    "Schema class constructors expect an object of decoded properties."
  )
}

export const prepareConstructionProps = (
  value: unknown,
  tag?: string
): Record<PropertyKey, unknown> => {
  const props = asConstructionRecord(value)
  if (tag === undefined) return props

  const suppliedTag = Reflect.get(props, "_tag") as unknown
  if (suppliedTag !== undefined && suppliedTag !== tag) {
    throw new BetterEffectZodError(
      "INVALID_TAG",
      `Expected _tag to be ${tag}, received ${String(suppliedTag)}.`
    )
  }

  if (
    suppliedTag === tag
    && Object.prototype.hasOwnProperty.call(props, "_tag")
  ) {
    return props
  }

  return { ...props, _tag: tag }
}

export const validateDecodedProps = (
  propsSchema: z.ZodType,
  props: unknown
): Record<PropertyKey, unknown> => {
  const candidate = asConstructionRecord(props)

  return z.parse(
    propsSchema,
    candidate
  ) as Record<PropertyKey, unknown>
}

export const validateDecodedPropsAsync = async (
  propsSchema: z.ZodType,
  props: unknown
): Promise<Record<PropertyKey, unknown>> => {
  const candidate = asConstructionRecord(props)

  return (await z.parseAsync(
    propsSchema,
    candidate
  )) as Record<PropertyKey, unknown>
}

export const safeValidateDecodedProps = (
  propsSchema: z.ZodType,
  props: unknown
): z.ZodSafeParseResult<Record<PropertyKey, unknown>> => {
  const candidate = asConstructionRecord(props)

  return z.safeParse(
    propsSchema,
    candidate
  ) as z.ZodSafeParseResult<Record<PropertyKey, unknown>>
}

export const safeValidateDecodedPropsAsync = async (
  propsSchema: z.ZodType,
  props: unknown
): Promise<z.ZodSafeParseResult<Record<PropertyKey, unknown>>> => {
  const candidate = asConstructionRecord(props)

  return (await z.safeParseAsync(
    propsSchema,
    candidate
  )) as z.ZodSafeParseResult<Record<PropertyKey, unknown>>
}

export const assignProps = (
  instance: object,
  props: Record<PropertyKey, unknown>
): void => {
  for (const key of Reflect.ownKeys(props)) {
    const descriptor = Object.getOwnPropertyDescriptor(props, key)
    if (descriptor?.enumerable !== true) continue

    Object.defineProperty(instance, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: props[key]
    })
  }
}

export const extractProps = (
  instance: object
): Record<PropertyKey, unknown> => {
  const props: Record<PropertyKey, unknown> = {}

  for (const key of Reflect.ownKeys(instance)) {
    const descriptor = Object.getOwnPropertyDescriptor(instance, key)
    if (descriptor?.enumerable !== true) continue
    props[key] = Reflect.get(instance, key) as unknown
  }

  return props
}

const readMarker = (value: object): InstanceMarker | undefined => {
  const marker = Reflect.get(value, INSTANCE_MARKER) as unknown
  if (typeof marker !== "object" || marker === null) return undefined

  const identifier = Reflect.get(marker, "identifier") as unknown
  const kind = Reflect.get(marker, "kind") as unknown
  if (typeof identifier !== "string") return undefined
  if (kind !== "class" && kind !== "tagged-class" && kind !== "tagged-error") {
    return undefined
  }

  return { identifier, kind }
}

const findMarker = (value: unknown): InstanceMarker | undefined => {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined
  }

  let current: object | null = value
  while (current !== null) {
    const marker = Object.prototype.hasOwnProperty.call(current, INSTANCE_MARKER)
      ? readMarker(current)
      : undefined

    if (marker !== undefined) return marker
    current = Object.getPrototypeOf(current) as object | null
  }

  return undefined
}

export const isClassInstanceValue = (value: unknown): value is object =>
  findMarker(value) !== undefined

export const hasClassIdentity = (
  value: unknown,
  identifier: string,
  kind: ClassKind
): boolean => {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return false
  }

  let current: object | null = value
  while (current !== null) {
    const marker = Object.prototype.hasOwnProperty.call(current, INSTANCE_MARKER)
      ? readMarker(current)
      : undefined

    if (marker?.identifier === identifier && marker.kind === kind) return true
    current = Object.getPrototypeOf(current) as object | null
  }

  return false
}
