# API Reference

## Imports

```ts
import {
  Schema,
  Class,
  TaggedClass,
  TaggedError,
  SchemaDecodeFailure,
  SchemaEncodeFailure,
  SchemaConstructionFailure,
  BetterEffectZodError
} from "better-effect-zod"
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
class User extends Schema.Class<User>("@app/User")({
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

Returns `SchemaDecodeFailure` for expected Zod validation failures.

### decode

```ts
Schema.decode(schema)(input: z.input<typeof schema>)
Schema.decode(schema, input)
```

Like `decodeUnknown`, but preserves the schema's encoded input type at the call site.

### decodeUnknownAsync and decodeAsync

```ts
await Schema.decodeUnknownAsync(schema)(input)
await Schema.decodeAsync(schema)(input)
```

Support asynchronous schemas and return `Promise<Effect<...>>`.

### encode and encodeAsync

```ts
Schema.encode(schema)(value: z.output<typeof schema>)
await Schema.encodeAsync(schema)(value)
```

Return the schema input representation or `SchemaEncodeFailure`.

### make and makeAsync

```ts
Schema.make(SchemaClass)(props)
await Schema.makeAsync(SchemaClass)(props)
```

Validate decoded constructor properties and return a concrete instance or `SchemaConstructionFailure`.

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

## Type helpers

```ts
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
SchemaEncodeFailure
SchemaConstructionFailure
```

Shared properties:

```ts
readonly _tag: string
readonly identifier: string
readonly message: string
readonly issues: readonly SchemaIssue[]
readonly cause: z.ZodError // non-enumerable in memory
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
