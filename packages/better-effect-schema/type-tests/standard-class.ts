import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { TaggedErrorInstance } from 'better-result'

import { Schema } from '../src/index.js'
import type { GenericSchemaClass } from '../src/types/generic-class.js'
import type { TaggedEncoded, TaggedInstance, TaggedProps } from '../src/types/tagged.js'

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false

type Assert<Value extends true> = Value

const objectSchema: StandardSchemaV1<{ id: string }, { id: string }> = {
  '~standard': {
    version: 1,
    vendor: 'type-test',
    validate(value) {
      const input = value as { readonly id?: unknown }
      return typeof value === 'object' && value !== null && typeof input.id === 'string'
        ? { value: { id: input.id } }
        : { issues: [{ message: 'invalid object' }] }
    }
  }
}

const stringSchema: StandardSchemaV1<string, string> = {
  '~standard': {
    version: 1,
    vendor: 'type-test',
    validate(value) {
      return typeof value === 'string' ? { value } : { issues: [{ message: 'invalid string' }] }
    }
  }
}

const userDefinition = {
  schema: objectSchema,
  propsSchema: objectSchema
}

class User extends Schema.Class<User>('types/StandardUser')(userDefinition) {}

const constructed = new User({ id: 'id' })
type _NewOutput = Assert<Equal<typeof constructed, User>>

const createdFields = { id: stringSchema }
const notFoundFields = { id: stringSchema }

class Created extends Schema.TaggedClass<Created>()('types/Created', {
  id: stringSchema
}) {}

class NotFound extends Schema.TaggedError<NotFound>()('types/NotFound', {
  id: stringSchema
}) {}

type UserInput = StandardSchemaV1.InferInput<typeof User>
type UserOutput = StandardSchemaV1.InferOutput<typeof User>
type CreatedInput = StandardSchemaV1.InferInput<typeof Created>
type CreatedOutput = StandardSchemaV1.InferOutput<typeof Created>
type NotFoundInput = StandardSchemaV1.InferInput<typeof NotFound>
type NotFoundOutput = StandardSchemaV1.InferOutput<typeof NotFound>

type _UserInput = Assert<Equal<UserInput, { id: string }>>
type _UserOutput = Assert<Equal<UserOutput, User>>
type ExpectedCreatedInput = TaggedEncoded<'types/Created', typeof createdFields>
type ExpectedCreatedOutput = TaggedInstance<Created, 'types/Created', typeof createdFields>
type ExpectedNotFoundInput = TaggedEncoded<'types/NotFound', typeof notFoundFields>
type ExpectedNotFoundOutput = TaggedErrorInstance<
  'types/NotFound',
  TaggedProps<typeof notFoundFields>
> &
  Readonly<TaggedProps<typeof notFoundFields>>

type _CreatedInput = Assert<Equal<CreatedInput, ExpectedCreatedInput>>
type _CreatedOutput = Assert<Equal<CreatedOutput, ExpectedCreatedOutput>>
type _NotFoundInput = Assert<Equal<NotFoundInput, ExpectedNotFoundInput>>
type _NotFoundOutput = Assert<Equal<NotFoundOutput, ExpectedNotFoundOutput>>

const userSchema: StandardSchemaV1<{ id: string }, User> = User
const userClass: GenericSchemaClass<User, typeof userDefinition> = User
const createdSchema: StandardSchemaV1<ExpectedCreatedInput, ExpectedCreatedOutput> = Created
const notFoundSchema: StandardSchemaV1<ExpectedNotFoundInput, ExpectedNotFoundOutput> = NotFound

const protocolResult = User['~standard'].validate(
  { id: 'u-1' },
  { libraryOptions: { source: 'type-test' } }
)
protocolResult satisfies StandardSchemaV1.Result<User> | Promise<StandardSchemaV1.Result<User>>

void userSchema
void userClass
void createdSchema
void notFoundSchema
