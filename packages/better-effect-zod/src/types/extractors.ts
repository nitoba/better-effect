import type * as z from "zod"

import type { CLASS_TYPE_ID } from "../internal/symbols.js"
import type { ClassTypeMetadata } from "./class-metadata.js"
import type { ClassDefinition, RawShape, Simplify } from "./common.js"

export type Props<Class> = Class extends {
  readonly [CLASS_TYPE_ID]: ClassTypeMetadata<
    unknown,
    ClassDefinition,
    infer ConstructorProps,
    unknown,
    unknown,
    PropertyKey,
    RawShape
  >
} ? Simplify<ConstructorProps> : never

export type Fields<Class> = Class extends {
  readonly [CLASS_TYPE_ID]: ClassTypeMetadata<
    unknown,
    ClassDefinition,
    unknown,
    unknown,
    unknown,
    PropertyKey,
    infer ClassFields
  >
} ? ClassFields : never

export type Struct<Class> = Class extends {
  readonly [CLASS_TYPE_ID]: ClassTypeMetadata<
    unknown,
    infer Definition,
    unknown,
    unknown,
    unknown,
    PropertyKey,
    RawShape
  >
} ? Definition : never

export type Encoded<Class> = Class extends z.ZodType<unknown, infer Input>
  ? Simplify<Input>
  : never

export type Instance<Class> = Class extends {
  readonly [CLASS_TYPE_ID]: ClassTypeMetadata<
    infer Self,
    ClassDefinition,
    unknown,
    unknown,
    unknown,
    PropertyKey,
    RawShape
  >
} ? Self : never
