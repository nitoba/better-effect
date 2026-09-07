import { Effect } from 'better-effect'
import { Result, type Result as ResultType } from 'better-result'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import * as v from 'valibot'
import { type as arkType } from 'arktype'
import * as z from 'zod'

import {
  Schema,
  SchemaAsyncRequired,
  SchemaConstructionFailure,
  SchemaDecodeFailure,
  SchemaDefinitionFailure,
  SchemaEncodeFailure,
  SchemaExecutionFailure,
  type GenericClassDefinition,
  type GenericSchemaClass,
  type SchemaCodec
} from '../src/index.js'
import { ArkTypeAdapter } from '../src/arktype.js'
import { ValibotAdapter } from '../src/valibot.js'
import { ZodAdapter } from '../src/zod.js'
import type { Equal, Expect } from './helpers.js'

type Wire = { readonly id: string }
type Domain = { readonly id: number }

const wireSchema: StandardSchemaV1<Wire, Wire> = {
  '~standard': {
    version: 1 as const,
    vendor: 'conformance-types',
    validate(value: unknown) {
      return typeof value === 'object' &&
        value !== null &&
        typeof Reflect.get(value, 'id') === 'string'
        ? { value: value as Wire }
        : { issues: [{ message: 'Expected a wire object' }] }
    }
  }
}

const domainSchema: StandardSchemaV1<Wire, Domain> = {
  '~standard': {
    version: 1,
    vendor: 'conformance-types-domain',
    validate(value: unknown) {
      return typeof value === 'object' &&
        value !== null &&
        typeof Reflect.get(value, 'id') === 'string'
        ? { value: { id: Number(Reflect.get(value, 'id')) } }
        : { issues: [{ message: 'Expected a wire object' }] }
    }
  }
}

const domainPropsSchema: StandardSchemaV1<Domain, Domain> = {
  '~standard': {
    version: 1,
    vendor: 'conformance-types-props',
    validate(value: unknown) {
      return typeof value === 'object' &&
        value !== null &&
        typeof Reflect.get(value, 'id') === 'number'
        ? { value: { id: Reflect.get(value, 'id') as number } }
        : { issues: [{ message: 'Expected domain props' }] }
    }
  }
}

const stringSchema: StandardSchemaV1<string, string> = {
  '~standard': {
    version: 1,
    vendor: 'conformance-types-string',
    validate(value: unknown) {
      return typeof value === 'string' ? { value } : { issues: [{ message: 'Expected a string' }] }
    }
  }
}

const codec = {
  schema: domainSchema,
  encodedSchema: wireSchema,
  encode(value: Domain) {
    return Result.ok({ id: String(value.id) })
  }
} satisfies SchemaCodec<Wire, Domain, Domain, Wire>

const decoded = Schema.decodeUnknown(wireSchema, { id: '7' })
decoded satisfies Effect<
  Wire,
  SchemaDecodeFailure | SchemaDefinitionFailure | SchemaExecutionFailure | SchemaAsyncRequired,
  never
>

const encoded = Schema.encode(codec, { id: 7 })
encoded satisfies Effect<
  Wire,
  SchemaEncodeFailure | SchemaExecutionFailure | SchemaAsyncRequired,
  never
>

const program = Effect.fn(function* () {
  const value = yield* decoded
  const wire = yield* encoded
  return Result.ok({ value, wire })
})
type _ProgramRequirements = Expect<Equal<Effect.Requirements<typeof program>, never>>
type _ProgramSuccess = Expect<Equal<Effect.Success<typeof program>, { value: Wire; wire: Wire }>>

const zodLocal = Schema.with(ZodAdapter)
const zodSchema = z.object({ id: z.string() })
zodLocal.read(zodSchema)
zodLocal.fields(zodSchema)
zodLocal.derive(zodSchema, 'pick', { id: true })

const valibotLocal = Schema.with(ValibotAdapter)
const valibotSchema = v.object({ id: v.string() })
valibotLocal.read(valibotSchema)
valibotLocal.derive(valibotSchema, 'partial')
// @ts-expect-error Valibot does not advertise an encoder without explicit configuration.
valibotLocal.encode
// @ts-expect-error Valibot does not advertise a JSON Schema capability.
valibotLocal.toJSONSchema

const arkTypeLocal = Schema.with(ArkTypeAdapter)
const arkSchema = arkType({ id: 'string' })
arkTypeLocal.read(arkSchema)
arkTypeLocal.derive(arkSchema, 'pick', ['id'])
// @ts-expect-error ArkType projections are not an inverse encoder.
arkTypeLocal.encode
// @ts-expect-error ArkType does not advertise a JSON Schema capability.
arkTypeLocal.toJSONSchema

const grouped = Schema.with({
  capabilities: {
    jsonSchema: {
      toJSONSchema: <Input, Output>(
        _schema: StandardSchemaV1<Input, Output>,
        _options: { readonly target: string }
      ) => Result.ok({ type: 'object' })
    }
  }
})
grouped.toJSONSchema(wireSchema, { target: 'draft-2020-12' })

const Tagged = Schema.TaggedClass<{ readonly id: number }>()('ConformanceTagged', {
  id: z.number()
})
const taggedValue = new Tagged({ id: 1 })
const taggedEncoded: Schema.Encoded<typeof Tagged> = { _tag: 'ConformanceTagged', id: 1 }
void taggedValue
void taggedEncoded

const portableDefinition = {
  schema: domainSchema,
  propsSchema: domainPropsSchema,
  encodedSchema: wireSchema
} satisfies GenericClassDefinition<Wire, Domain, Domain, Wire>

class PortableUser extends Schema.Class<PortableUser>('PortableUser')(portableDefinition) {}

const portableClass: GenericSchemaClass<PortableUser, typeof portableDefinition> = PortableUser

const portableMade = portableClass.make({ id: 7 })
portableMade satisfies ResultType<
  PortableUser,
  SchemaAsyncRequired | SchemaConstructionFailure | SchemaDefinitionFailure | SchemaExecutionFailure
>
const portableDecoded = Schema.decodeUnknown(portableClass, { id: 'decoded' })
portableDecoded satisfies Effect<
  PortableUser,
  | SchemaAsyncRequired
  | SchemaConstructionFailure
  | SchemaDecodeFailure
  | SchemaDefinitionFailure
  | SchemaExecutionFailure,
  never
>

const PortableTagged = Schema.TaggedClass<{ readonly id: string }>()('PortableTagged', {
  id: stringSchema
})
type _PortableTaggedEncoded = Expect<
  Equal<
    Schema.Encoded<typeof PortableTagged>,
    { readonly _tag: 'PortableTagged'; readonly id: string }
  >
>
const portableTagged = PortableTagged.make({ id: 'tagged' })
portableTagged satisfies Effect<
  InstanceType<typeof PortableTagged>,
  | SchemaAsyncRequired
  | SchemaConstructionFailure
  | SchemaDefinitionFailure
  | SchemaExecutionFailure,
  never
>

type _PortableProps = Expect<Equal<Schema.Props<typeof PortableUser>, Domain>>
type _PortableEncoded = Expect<Equal<Schema.Encoded<typeof PortableUser>, Wire>>
type _PortableNotZod = Expect<Equal<PortableUser extends z.ZodType ? true : false, false>>

type _Input = Expect<Equal<Schema.Input<typeof codec>, Wire>>
type _Output = Expect<Equal<Schema.Output<typeof codec>, Domain>>
type _Encoded = Expect<Equal<Schema.Encoded<typeof codec>, Wire>>
