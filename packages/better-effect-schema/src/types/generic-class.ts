import type { StandardSchemaV1 } from '@standard-schema/spec'

import type { CLASS_TYPE_ID } from '../internal/symbols.js'

export type GenericClassAnnotations = Readonly<Record<string, unknown>>

export type GenericSchemaFieldMap = Readonly<Record<string, StandardSchemaV1>>

/** The provider-neutral definition consumed by Schema.Class. */
export interface GenericClassDefinition<
  Input = unknown,
  ConstructorInput = Input,
  Props = ConstructorInput,
  Encoded = Input
> {
  readonly schema: StandardSchemaV1<Input, ConstructorInput>
  readonly propsSchema: StandardSchemaV1<ConstructorInput, Props>
  readonly encodedSchema?: StandardSchemaV1<Encoded, Encoded>
  readonly fields?: GenericSchemaFieldMap
  readonly struct?: unknown
  readonly codec?: unknown
  readonly encode?: (value: Props) => Encoded | PromiseLike<Encoded>
}

export type GenericClassInput<Definition extends GenericClassDefinition> =
  Definition extends GenericClassDefinition<infer Input, unknown, unknown, unknown> ? Input : never

export type GenericClassConstructorInput<Definition extends GenericClassDefinition> =
  Definition extends GenericClassDefinition<unknown, infer Input, unknown, unknown> ? Input : never

export type GenericClassProps<Definition extends GenericClassDefinition> =
  Definition extends GenericClassDefinition<unknown, unknown, infer Props, unknown> ? Props : never

export type GenericClassEncoded<Definition extends GenericClassDefinition> =
  Definition extends GenericClassDefinition<unknown, unknown, unknown, infer Encoded>
    ? Encoded
    : never

export type GenericClassFields<Definition extends GenericClassDefinition> = Definition extends {
  readonly fields: infer Fields
}
  ? Fields
  : never

export type GenericClassStruct<Definition extends GenericClassDefinition> = Definition extends {
  readonly struct: infer Struct
}
  ? Struct
  : never

export type GenericClassFailure =
  | import('../failure.js').SchemaAsyncRequired
  | import('../failure.js').SchemaConstructionFailure
  | import('../failure.js').SchemaDefinitionFailure
  | import('../failure.js').SchemaExecutionFailure

export interface GenericClassTypeMetadata<Self, Definition extends GenericClassDefinition> {
  readonly self: Self
  readonly definition: Definition
  readonly input: GenericClassInput<Definition>
  readonly constructorInput: GenericClassConstructorInput<Definition>
  readonly props: GenericClassProps<Definition>
  readonly encoded: GenericClassEncoded<Definition>
}

export type GenericConstructorArgs<Input> = keyof Input extends never
  ? readonly [input?: Input]
  : {} extends Input
    ? readonly [input?: Input]
    : readonly [input: Input]

interface GenericClassFluent<Self, Definition extends GenericClassDefinition> {
  meta(): GenericClassAnnotations | undefined
  meta(metadata: GenericClassAnnotations): this
  describe(description: string): this
  register<Metadata>(
    registry: { add(value: object, metadata?: Metadata): unknown },
    metadata?: Metadata
  ): this
}

export type GenericSchemaClass<Self, Definition extends GenericClassDefinition> = {
  new (...args: GenericConstructorArgs<GenericClassProps<Definition>>): Self

  readonly [CLASS_TYPE_ID]: GenericClassTypeMetadata<Self, Definition>
  readonly identifier: string
  readonly kind: 'class'
  readonly '~standard': StandardSchemaV1<GenericClassInput<Definition>, Self>['~standard']
  readonly schema: Definition['schema']
  readonly propsSchema: Definition['propsSchema']
  readonly encodedSchema: Definition['encodedSchema'] | undefined
  readonly fields: Definition['fields'] | undefined
  readonly struct: Definition['struct'] | undefined
  readonly codec: Definition['codec'] | undefined

  make(
    input: GenericClassConstructorInput<Definition>
  ): import('better-result').Result<Self, GenericClassFailure>
  unsafeMake(
    props: GenericClassProps<Definition>
  ): import('better-result').Result<Self, GenericClassFailure>
  makeAsync(
    input: GenericClassConstructorInput<Definition>
  ): Promise<
    import('better-result').Result<
      Self,
      Exclude<GenericClassFailure, import('../failure.js').SchemaAsyncRequired>
    >
  >

  is(value: unknown): value is Self
} & GenericClassFluent<Self, Definition>

type GenericSchemaClassDeclaration<Self, Definition extends GenericClassDefinition> = Omit<
  GenericSchemaClass<Self, Definition>,
  never
> & {
  new (
    ...args: GenericConstructorArgs<GenericClassProps<Definition>>
  ): GenericClassProps<Definition> & {
    readonly [CLASS_TYPE_ID]?: GenericClassTypeMetadata<Self, Definition>
  }
}

export interface GenericClassBuilder<Self> {
  <Definition extends GenericClassDefinition>(
    definition: Definition
  ): GenericSchemaClassDeclaration<Self, Definition>
}

type MissingSelfGeneric<Factory extends string> =
  `Missing \`Self\` generic - use \`class Self extends Schema.${Factory}<Self>(...)\``

export interface GenericClassFactory {
  <Self = never>(
    identifier: string,
    annotations?: GenericClassAnnotations
  ): [Self] extends [never] ? MissingSelfGeneric<'Class'> : GenericClassBuilder<Self>
}
