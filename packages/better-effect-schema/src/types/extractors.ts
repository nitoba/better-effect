import type * as z from 'zod'
import type { StandardSchemaV1 } from '@standard-schema/spec'

import type { CLASS_TYPE_ID } from '../internal/symbols.js'
import type { ClassTypeMetadata } from './class-metadata.js'
import type { ClassDefinition, RawShape, Simplify } from './common.js'

export type Input<Schema> = Schema extends {
  readonly schema: infer Definition extends StandardSchemaV1
}
  ? StandardSchemaV1.InferInput<Definition>
  : Schema extends StandardSchemaV1
    ? StandardSchemaV1.InferInput<Schema>
    : never

export type Output<Schema> = Schema extends {
  readonly schema: infer Definition extends StandardSchemaV1
}
  ? StandardSchemaV1.InferOutput<Definition>
  : Schema extends StandardSchemaV1
    ? StandardSchemaV1.InferOutput<Schema>
    : never

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
}
  ? Simplify<ConstructorProps>
  : Class extends {
        readonly propsSchema: infer Projection extends StandardSchemaV1
      }
    ? StandardSchemaV1.InferOutput<Projection>
    : never

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
}
  ? ClassFields
  : never

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
}
  ? Definition
  : never

export type Encoded<Class> =
  Class extends z.ZodType<unknown, infer Input>
    ? Simplify<Input>
    : Class extends {
          readonly encodedSchema: infer Projection extends StandardSchemaV1
        }
      ? StandardSchemaV1.InferOutput<Projection>
      : Class extends StandardSchemaV1
        ? StandardSchemaV1.InferInput<Class>
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
}
  ? Self
  : never
