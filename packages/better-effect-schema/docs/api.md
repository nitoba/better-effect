# API Reference

## Imports

```ts
import {
  Schema,
  Class,
  TaggedClass,
  TaggedError,
  SchemaAsyncRequired,
  SchemaDecodeFailure,
  SchemaDefinitionFailure,
  SchemaEncodeFailure,
  SchemaConstructionFailure,
  SchemaExecutionFailure,
  BetterEffectZodError
} from 'better-effect-schema'
```

`Schema` is the preferred facade. Top-level factory and operation exports are the same function objects. `Z` and `ZodClassError` are deprecated migration aliases.

## Schema.Class

```ts
Schema.Class<Self>(identifier, annotations?)(definition)
```

`definition` may be:

- a raw Zod object shape;
- a configured `ZodObject`;
- a bidirectional `ZodCodec` whose encoded and decoded projections are objects.

```ts
class User extends Schema.Class<User>('@app/User')({
  id: z.uuid(),
  name: z.string()
}) {}
```

The `Self` generic is required for exact instance inference.

## Schema.TaggedClass

```ts
Schema.TaggedClass<Self>()(tag, fields, annotations?)
```

Adds a required literal `_tag` to encoded values and injects it during construction. `_tag` cannot be declared, removed, replaced, or optionalized by callers.

## Schema.TaggedError

```ts
Schema.TaggedError<Self>()(tag, fields, annotations?)
```

Creates a schema-backed subclass of `better-result.TaggedError(tag)`. Instances support:

```ts
error instanceof Error
ErrorClass.is(error)
error.match(handlers)
error[Symbol.iterator]()
error.toJSON()
```

Reserved field names are `_tag`, `name`, `stack`, `match`, and `toJSON`. Use `Schema.encode(ErrorClass)(error)` for a schema-controlled transport representation. The inherited `better-result` `toJSON()` remains a diagnostic contract and may be overridden in the class body when a stricter envelope is required.

## Schema operations

All synchronous operations return `Effect<Value, Failure, never>`, represented at runtime by a `better-result` Result.

### decodeUnknown

```ts
Schema.decodeUnknown(schema)(input: unknown)
Schema.decodeUnknown(schema, input)
```

Accepts any Standard Schema validator and returns
`SchemaDecodeFailure | SchemaDefinitionFailure | SchemaExecutionFailure |
SchemaAsyncRequired`.

### decode

```ts
Schema.decode(schema)(input: z.input<typeof schema>)
Schema.decode(schema, input)
```

Like `decodeUnknown`, but preserves the Standard Schema input type at the call site.

### decodeUnknownAsync and decodeAsync

```ts
await Schema.decodeUnknownAsync(schema)(input)
await Schema.decodeAsync(schema)(input)
```

Support synchronous or asynchronous Standard Schema validators and return
`Promise<Effect<...>>` with the same decode failure channel.

### encode and encodeAsync

```ts
Schema.encode(codec)(value: Schema.Output<typeof codec>)
await Schema.encodeAsync(codec)(value)
```

Return the schema input representation or
`SchemaEncodeFailure | SchemaExecutionFailure | SchemaAsyncRequired`.

The codec must explicitly provide `schema`, `encodedSchema`, and `encode`.
`encodedSchema` is the validation boundary for the representation produced by
the encoder; the read schema is never run again during encoding. A missing
encoder is `SchemaUnsupportedOperation` at runtime when reached through a JS
call or cast, and a one-way Standard Schema is never treated as its own codec.

The encoder is invoked once. Explicit `Result.err` values are preserved,
unexpected throws/rejections become `SchemaExecutionFailure`, and a sync call
that observes a thenable returns `SchemaAsyncRequired`.

### make and makeAsync

```ts
Schema.make(SchemaClass)(props)
await Schema.makeAsync(SchemaClass)(props)
```

Validate decoded constructor properties and return a concrete instance or
`SchemaConstructionFailure | SchemaExecutionFailure | SchemaAsyncRequired`.

## Native construction APIs

```ts
new Model(props)
Model.make(props)
Model.unsafeMake(props)
await Model.makeAsync(props)
Model.safeMake(props)
await Model.safeMakeAsync(props)
```

`unsafeMake` is the only public validation bypass.

## Native Zod APIs

A schema class extends the public `ZodType` contract and delegates to a concrete codec:

```ts
Model.parse(input)
Model.safeParse(input)
Model.decode(input)
Model.encode(instance)
Model.parseAsync(input)
Model.decodeAsync(input)
Model.encodeAsync(instance)
Model.optional()
Model.nullable()
Model.array()
Model.or(other)
Model.and(other)
Model.pipe(other)
```

The class may also be passed to `z.array`, `z.object`, `z.union`, `z.compile`, `z.validate`, and other public schema consumers.

## Static schema-class properties

```ts
Model.identifier: string
Model.fields: RawShape
Model.struct: ZodObject | ZodCodec
Model.schema: typeof Model
Model.codec: ZodType
Model.encodedSchema: ZodType<Encoded, Encoded>
Model.propsSchema: ZodType<Props, Props>
Model.kind: "class" | "tagged-class" | "tagged-error"
```

`codec` is cached per concrete constructor. `encodedSchema` and `propsSchema` do not construct class instances.

## Structural derivations

Object-backed classes expose:

```ts
Model.extend<Derived>(identifier, annotations?)(augmentation)
Model.pick<Derived>(identifier, annotations?)(mask)
Model.omit<Derived>(identifier, annotations?)(mask)
Model.partial<Derived>(identifier, mask?, annotations?)
Model.exactPartial<Derived>(identifier, mask?, annotations?)
Model.deepPartial<Derived>(identifier, annotations?)
Model.required<Derived>(identifier, mask?, annotations?)
Model.strict<Derived>(identifier, annotations?)
Model.loose<Derived>(identifier, annotations?)
Model.strip<Derived>(identifier, annotations?)
Model.catchall<Derived>(identifier, annotations?)(schema)
```

Whole-object codec classes intentionally omit these methods.

## Metadata and JSON Schema

```ts
Model.meta()
Model.meta(metadata)
Model.describe(description)
Model.register(registry, metadata?)
Model.toJSONSchema(params?)
```

`toJSONSchema()` defaults to the encoded input side.

## Guards

```ts
Schema.isSchemaClass(value)
Schema.isClassInstance(value)
Model.is(value)
```

`Model.is` uses stable logical identity and class kind rather than only constructor reference identity.

## Standard Schema and capabilities

`Class`, `TaggedClass`, and `TaggedError` implement Standard Schema V1 through
`Model['~standard']`. Its `validate` method returns the protocol shape directly:

```ts
const result = await Model['~standard'].validate(input, {
  libraryOptions: { source: 'request' }
})

// success: { value: ModelInstance }
// failure: { issues: readonly StandardSchemaV1.Issue[] }
```

The bridge never returns `Result`. A successful tagged error is a `value`, not
a validation failure, and async validation/construction is executed once.

The four `Schema.decode*` operations consume only the Standard Schema V1
`~standard.validate` protocol. They accept any conforming provider, preserve
the provider's transformed output, and return `Result` values through
`SchemaEffect`. The optional `libraryOptions` object is forwarded unchanged.

Advanced operations are provided explicitly by local adapters:

```ts
const Local = Schema.with({
  encoding: {
    encode(schema, value) {
      return Result.ok(value)
    }
  }
})

Local.encode(schema, value)
```

`Schema.with` returns a frozen facade. A capability that is absent, incomplete,
or unsupported is not represented by a placeholder method; available adapter
callbacks are invoked through the package's no-throw boundary.

## Type helpers

```ts
Schema.Input<typeof Model>
Schema.Output<typeof Model>
Schema.Props<typeof Model>
Schema.Fields<typeof Model>
Schema.Struct<typeof Model>
Schema.Encoded<typeof Model>
Schema.Instance<typeof Model>
Schema.Effect<Value, Failure>
```

Equivalent top-level types are exported as `Props`, `Fields`, `Struct`, `Encoded`, `Instance`, and `SchemaEffect`.

## Failures

```ts
SchemaDecodeFailure
SchemaDefinitionFailure
SchemaEncodeFailure
SchemaConstructionFailure
SchemaExecutionFailure
SchemaUnsupportedOperation
SchemaAsyncRequired
```

Shared properties:

```ts
readonly _tag: string
readonly identifier: string
readonly message: string
readonly issues: readonly SchemaIssue[]
readonly cause: unknown // non-enumerable in memory
```

`toJSON()` omits `cause`, `stack`, rejected values, and arbitrary validator messages.

## Package-contract errors

```ts
BetterEffectZodError
BetterEffectZodErrorCode
```

Codes:

```text
INVALID_DEFINITION
INVALID_IDENTIFIER
MISSING_DESCRIPTOR
INVALID_CONSTRUCTION
INVALID_DERIVATION
INVALID_TAG
```
