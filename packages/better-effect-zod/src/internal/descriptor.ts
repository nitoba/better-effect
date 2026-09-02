import { BetterEffectZodError } from "../errors.js"
import type {
  AnyObjectSchema,
  ClassAnnotations,
  ClassDefinition,
  ClassKind,
  RawShape
} from "../types.js"

export interface ClassDescriptor {
  readonly identifier: string
  readonly definition: ClassDefinition
  readonly derivationStruct: AnyObjectSchema | undefined
  readonly encodedSchema: AnyObjectSchema
  readonly propsSchema: AnyObjectSchema
  readonly fields: RawShape
  readonly annotations: ClassAnnotations | undefined
  readonly kind: ClassKind
  readonly tag: string | undefined
  readonly protectedKeys: readonly PropertyKey[]
  readonly parent: Function | undefined
}

const descriptors = new WeakMap<Function, ClassDescriptor>()

export const registerDescriptor = (
  constructor: Function,
  descriptor: ClassDescriptor
): void => {
  descriptors.set(constructor, descriptor)
}

export const findDescriptor = (
  constructor: Function
): ClassDescriptor | undefined => {
  let current: object | null = constructor

  while (typeof current === "function") {
    const descriptor = descriptors.get(current)
    if (descriptor !== undefined) return descriptor
    current = Object.getPrototypeOf(current) as object | null
  }

  return undefined
}

export const getDescriptor = (constructor: Function): ClassDescriptor => {
  const descriptor = findDescriptor(constructor)
  if (descriptor !== undefined) return descriptor

  throw new BetterEffectZodError(
    "MISSING_DESCRIPTOR",
    "The constructor is not backed by a Zod schema class descriptor."
  )
}
