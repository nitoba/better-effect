import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { Result } from 'better-result'

import {
  Schema,
  SchemaAsyncRequired,
  SchemaConstructionFailure,
  SchemaDefinitionFailure,
  SchemaExecutionFailure,
  type GenericClassFailure,
  type Props
} from '../src/index.js'
import type { Equal, Expect } from './helpers.js'

type Input = { readonly name: string }
type ConstructorInput = { readonly name: string }
type NormalizedProps = { readonly name: string; readonly count: number }

declare const inputSchema: StandardSchemaV1<Input, ConstructorInput>
declare const propsSchema: StandardSchemaV1<ConstructorInput, NormalizedProps>

class User extends Schema.Class<User>('type/User')({
  schema: inputSchema,
  propsSchema
}) {
  get label(): string {
    return `${this.name}:${this.count}`
  }
}

const made = User.make({ name: 'Ada' })
made satisfies Result<User, GenericClassFailure>

const unsafe = User.unsafeMake({ name: 'Ada', count: 1 })
unsafe satisfies Result<User, GenericClassFailure>

const decoded = Schema.decode(User, { name: 'Ada' })
decoded satisfies Schema.Effect<
  User,
  GenericClassFailure | import('../src/index.js').SchemaDecodeFailure,
  never
>

const curried = Schema.make(User)({ name: 'Ada' })
curried satisfies Schema.Effect<User, GenericClassFailure, never>

const asyncMade = User.makeAsync({ name: 'Ada' })
asyncMade satisfies Promise<Result<User, Exclude<GenericClassFailure, SchemaAsyncRequired>>>

type _Props = Expect<Equal<Props<typeof User>, NormalizedProps>>
type _FailureMembers = Expect<
  Equal<
    GenericClassFailure,
    | SchemaAsyncRequired
    | SchemaConstructionFailure
    | SchemaDefinitionFailure
    | SchemaExecutionFailure
  >
>

User.identifier satisfies string
User.kind satisfies 'class'
User.schema satisfies StandardSchemaV1<Input, ConstructorInput>
User.propsSchema satisfies StandardSchemaV1<ConstructorInput, NormalizedProps>
User.encodedSchema satisfies undefined
User.fields satisfies undefined
User.struct satisfies undefined
User.codec satisfies undefined
new User({ name: 'Ada', count: 1 })
