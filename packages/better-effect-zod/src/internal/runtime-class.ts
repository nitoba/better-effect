import type * as z from "zod"

import type { RawShape } from "../types.js"
import {
  enterPrevalidatedConstruction,
  getPrevalidatedConstruction,
  withPrevalidatedConstruction
} from "./construction-context.js"
import { findDescriptor, type ClassDescriptor } from "./descriptor.js"
import {
  assignProps,
  hasClassIdentity,
  prepareConstructionProps,
  safeValidateDecodedProps,
  safeValidateDecodedPropsAsync,
  validateDecodedProps,
  validateDecodedPropsAsync
} from "./instance.js"
import { getClassCodec } from "./codec.js"
import { INSTANCE_MARKER } from "./symbols.js"
import type {
  CreateClassOptions,
  RuntimeBase,
  RuntimeSchemaClass
} from "./class-types.js"

class EmptyBase {}

const classBase = (options: CreateClassOptions): RuntimeBase => {
  if (options.parent !== undefined) {
    return options.parent as unknown as RuntimeBase
  }
  if (options.runtimeBase !== undefined) return options.runtimeBase
  return EmptyBase
}

const descriptorFor = (
  constructor: Function,
  fallback: ClassDescriptor
): ClassDescriptor => findDescriptor(constructor) ?? fallback

const markerFor = (
  identifier: string,
  kind: ClassDescriptor["kind"]
): Readonly<{ identifier: string; kind: ClassDescriptor["kind"] }> =>
  Object.freeze({ identifier, kind })

const constructPrevalidated = (
  constructor: RuntimeSchemaClass,
  validated: Record<PropertyKey, unknown>
): object => withPrevalidatedConstruction(
  constructor,
  validated,
  () => Reflect.construct(constructor, [validated]) as object
)

export const createRuntimeClass = (
  options: CreateClassOptions,
  descriptor: ClassDescriptor
): RuntimeSchemaClass => {
  const Parent = classBase(options)

  class GeneratedSchemaClass extends Parent {
    constructor(props?: unknown) {
      const inheritedDescriptor = descriptorFor(new.target, descriptor)
      const prevalidated = getPrevalidatedConstruction(new.target, props)
      const prepared = prepareConstructionProps(
        prevalidated ?? props,
        inheritedDescriptor.tag
      )
      const validated = prevalidated === undefined
        ? validateDecodedProps(inheritedDescriptor.propsSchema, prepared)
        : prepared

      if (options.parent === undefined) {
        if (options.runtimeBase === undefined) {
          super()
        } else {
          super(validated)
        }
      } else {
        const leave = prevalidated === undefined
          ? enterPrevalidatedConstruction(new.target, validated)
          : undefined

        try {
          super(validated)
        } finally {
          leave?.()
        }
      }

      assignProps(this, validated)

      if (inheritedDescriptor.kind === "tagged-error") {
        Object.defineProperty(this, "name", {
          configurable: true,
          enumerable: false,
          writable: true,
          value: inheritedDescriptor.identifier
        })
      }
    }

    static get identifier(): string {
      return descriptorFor(this, descriptor).identifier
    }

    static get fields(): RawShape {
      return descriptorFor(this, descriptor).fields
    }

    static get struct(): z.ZodType {
      return descriptorFor(this, descriptor).definition
    }

    static get schema(): RuntimeSchemaClass {
      return this as unknown as RuntimeSchemaClass
    }

    static get codec(): z.ZodType {
      return getClassCodec(this)
    }

    static get encodedSchema(): z.ZodType {
      return descriptorFor(this, descriptor).encodedSchema
    }

    static get propsSchema(): z.ZodType {
      return descriptorFor(this, descriptor).propsSchema
    }

    static get kind(): ClassDescriptor["kind"] {
      return descriptorFor(this, descriptor).kind
    }

    static make(props?: unknown): object {
      return Reflect.construct(this, [props]) as object
    }

    static unsafeMake(props?: unknown): object {
      const concrete = this as unknown as RuntimeSchemaClass
      const inheritedDescriptor = descriptorFor(concrete, descriptor)
      const prepared = prepareConstructionProps(props, inheritedDescriptor.tag)

      return constructPrevalidated(concrete, prepared)
    }

    static async makeAsync(props?: unknown): Promise<object> {
      const concrete = this as unknown as RuntimeSchemaClass
      const inheritedDescriptor = descriptorFor(concrete, descriptor)
      const prepared = prepareConstructionProps(
        props,
        inheritedDescriptor.tag
      )
      const validated = await validateDecodedPropsAsync(
        inheritedDescriptor.propsSchema,
        prepared
      )

      return constructPrevalidated(concrete, validated)
    }

    static safeMake(props?: unknown): z.ZodSafeParseResult<object> {
      const concrete = this as unknown as RuntimeSchemaClass
      const inheritedDescriptor = descriptorFor(concrete, descriptor)
      const prepared = prepareConstructionProps(
        props,
        inheritedDescriptor.tag
      )
      const result = safeValidateDecodedProps(
        inheritedDescriptor.propsSchema,
        prepared
      )

      if (!result.success) return result
      return {
        success: true,
        data: constructPrevalidated(concrete, result.data)
      }
    }

    static async safeMakeAsync(
      props?: unknown
    ): Promise<z.ZodSafeParseResult<object>> {
      const concrete = this as unknown as RuntimeSchemaClass
      const inheritedDescriptor = descriptorFor(concrete, descriptor)
      const prepared = prepareConstructionProps(
        props,
        inheritedDescriptor.tag
      )
      const result = await safeValidateDecodedPropsAsync(
        inheritedDescriptor.propsSchema,
        prepared
      )

      if (!result.success) return result
      return {
        success: true,
        data: constructPrevalidated(concrete, result.data)
      }
    }

    static override [Symbol.hasInstance](value: unknown): boolean {
      const inheritedDescriptor = descriptorFor(this, descriptor)
      return hasClassIdentity(
        value,
        inheritedDescriptor.identifier,
        inheritedDescriptor.kind
      )
    }

    static is(value: unknown): boolean {
      return this[Symbol.hasInstance](value)
    }
  }

  Object.defineProperty(GeneratedSchemaClass.prototype, INSTANCE_MARKER, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: markerFor(descriptor.identifier, descriptor.kind)
  })

  return GeneratedSchemaClass as unknown as RuntimeSchemaClass
}
