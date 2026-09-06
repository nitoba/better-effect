import * as z from "zod"

import type {
  ClassAnnotations,
  ToJSONSchemaParams
} from "../types.js"
import type {
  RegistryLike,
  RuntimeSchemaClass
} from "./class-types.js"
import {
  describeClass,
  getMetadata,
  registerMetadata,
  registerWith
} from "./metadata.js"

const defineMethod = (
  constructor: RuntimeSchemaClass,
  name: PropertyKey,
  value: Function
): void => {
  Object.defineProperty(constructor, name, {
    configurable: true,
    enumerable: false,
    writable: true,
    value
  })
}

export const installSchemaApi = (
  constructor: RuntimeSchemaClass
): void => {
  defineMethod(constructor, "meta", function meta(
    this: RuntimeSchemaClass,
    metadata?: ClassAnnotations
  ): ClassAnnotations | RuntimeSchemaClass | undefined {
    if (arguments.length === 0) return getMetadata(this)
    registerMetadata(this, metadata ?? {})
    return this
  })

  defineMethod(constructor, "describe", function describe(
    this: RuntimeSchemaClass,
    description: string
  ): RuntimeSchemaClass {
    describeClass(this, description)
    return this
  })

  defineMethod(constructor, "register", function register<Metadata>(
    this: RuntimeSchemaClass,
    registry: RegistryLike<Metadata>,
    metadata?: Metadata
  ): RuntimeSchemaClass {
    registerWith(this, registry, metadata)
    return this
  })

  defineMethod(constructor, "toJSONSchema", function toJSONSchema(
    this: RuntimeSchemaClass,
    params?: ToJSONSchemaParams
  ): unknown {
    return z.toJSONSchema(
      this as unknown as z.ZodType,
      params ?? { io: "input" }
    )
  })
}
