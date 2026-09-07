import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { Effect } from 'better-effect'
import { Result } from 'better-result'

import {
  Schema,
  SchemaAsyncRequired,
  SchemaEncodeFailure,
  SchemaExecutionFailure,
  type SchemaCodec
} from '../src/index.js'
import type { Equal, Expect } from './helpers.js'

type ReadSchema = StandardSchemaV1<string, Date>
type PropsSchema = StandardSchemaV1<Readonly<{ value: Date }>, Readonly<{ value: Date }>>
type EncodedSchema = StandardSchemaV1<Readonly<{ value: string }>, Readonly<{ value: string }>>

declare const readSchema: ReadSchema
declare const propsSchema: PropsSchema
declare const encodedSchema: EncodedSchema

class EncodeRejected {
  readonly _tag = 'EncodeRejected'
}

const codec = {
  schema: readSchema,
  propsSchema,
  encodedSchema,
  encode(value: Date) {
    return Result.ok({ value: value.toISOString() })
  }
} satisfies SchemaCodec<string, Date, Readonly<{ value: Date }>, Readonly<{ value: string }>>

const encoded = Schema.encode(codec, new Date())
encoded satisfies Effect<
  Readonly<{ value: string }>,
  SchemaEncodeFailure | SchemaExecutionFailure | SchemaAsyncRequired,
  never
>

const curried = Schema.encode(codec)
curried(new Date())

const asyncCodec = {
  ...codec,
  async encodeAsync(_value: Date) {
    return Result.err<never, EncodeRejected>(new EncodeRejected())
  }
} satisfies SchemaCodec<
  string,
  Date,
  Readonly<{ value: Date }>,
  Readonly<{ value: string }>,
  EncodeRejected
>

const asyncEncoded = Schema.encodeAsync(asyncCodec, new Date())
void (asyncEncoded satisfies Promise<
  Effect<
    Readonly<{ value: string }>,
    EncodeRejected | SchemaEncodeFailure | SchemaExecutionFailure,
    never
  >
>)

type _Input = Expect<Equal<Schema.Input<typeof codec>, string>>
type _Output = Expect<Equal<Schema.Output<typeof codec>, Date>>
type _Props = Expect<Equal<Schema.Props<typeof codec>, Readonly<{ value: Date }>>>
type _Encoded = Expect<Equal<Schema.Encoded<typeof codec>, Readonly<{ value: string }>>>

const topLevelInput: import('../src/index.js').Input<typeof codec> = 'input'
const topLevelOutput: import('../src/index.js').Output<typeof codec> = new Date()
void topLevelInput
void topLevelOutput

// @ts-expect-error a read-only Standard Schema has no explicit encoded capability
Schema.encode(readSchema, new Date())

// @ts-expect-error the encoder receives the decoded output, not the encoded input
Schema.encode(codec, '2026-09-06T00:00:00.000Z')

void SchemaAsyncRequired
