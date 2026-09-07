import type * as z from 'zod'
import type { StandardSchemaV1 } from '@standard-schema/spec'

import type { CLASS_TYPE_ID } from '../internal/symbols.js'
import type { ClassTypeMetadata } from './class-metadata.js'
import type { GenericClassDefinition, GenericClassTypeMetadata } from './generic-class.js'
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

type GenericProps<Class> = Class extends {
  readonly [CLASS_TYPE_ID]: GenericClassTypeMetadata<
    unknown,
    infer Definition extends GenericClassDefinition
  >
}
  ? Simplify<import('./generic-class.js').GenericClassProps<Definition>>
  : never

type GenericFields<Class> = Class extends {
  readonly [CLASS_TYPE_ID]: GenericClassTypeMetadata<
    unknown,
    infer Definition extends GenericClassDefinition
  >
}
  ? import('./generic-class.js').GenericClassFields<Definition>
  : never

type GenericStruct<Class> = Class extends {
  readonly [CLASS_TYPE_ID]: GenericClassTypeMetadata<
    unknown,
    infer Definition extends GenericClassDefinition
  >
}
  ? import('./generic-class.js').GenericClassStruct<Definition>
  : never

type GenericEncoded<Class> = Class extends {
  readonly [CLASS_TYPE_ID]: GenericClassTypeMetadata<
    unknown,
    infer Definition extends GenericClassDefinition
  >
}
  ? Simplify<import('./generic-class.js').GenericClassEncoded<Definition>>
  : never

type GenericInstance<Class> = Class extends {
  readonly [CLASS_TYPE_ID]: GenericClassTypeMetadata<infer Self, GenericClassDefinition>
}
  ? Self
  : never

export type Props<Class> = [GenericProps<Class>] extends [never]
  ? Class extends {
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
  : GenericProps<Class>

export type Fields<Class> = [GenericFields<Class>] extends [never]
  ? Class extends {
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
  : GenericFields<Class>

export type Struct<Class> = [GenericStruct<Class>] extends [never]
  ? Class extends {
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
  : GenericStruct<Class>

export type Encoded<Class> = [GenericEncoded<Class>] extends [never]
  ? Class extends z.ZodType<unknown, infer Input>
    ? Simplify<Input>
    : Class extends {
          readonly encodedSchema: infer Projection extends StandardSchemaV1
        }
      ? StandardSchemaV1.InferOutput<Projection>
      : Class extends StandardSchemaV1
        ? StandardSchemaV1.InferInput<Class>
        : never
  : GenericEncoded<Class>

export type Instance<Class> = [GenericInstance<Class>] extends [never]
  ? Class extends {
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
  : GenericInstance<Class>
