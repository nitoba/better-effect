# API reference

## Imports

```ts
import {
  Schema,
  SchemaAsyncRequired,
  SchemaConstructionFailure,
  SchemaDecodeFailure,
  SchemaDefinitionFailure,
  SchemaEncodeFailure,
  SchemaExecutionFailure,
  SchemaUnsupportedOperation
} from 'better-effect-schema'
```

The root package is provider-neutral. Import a provider adapter from its
subpath and create a local facade when provider-native classes or capabilities
are needed:

```ts
import { ZodAdapter } from 'better-effect-schema/zod'
const Local = Schema.with(ZodAdapter)
```

## Classes

```ts
Schema.Class<Self>(identifier, annotations?)(definition)
Schema.TaggedClass<Self>()(tag, fields, annotations?)
Schema.TaggedError<Self>()(tag, fields, annotations?)
```

`Schema.Class` receives a `GenericClassDefinition` with `schema` and
`propsSchema` Standard Schema capabilities. `encodedSchema` and `encode` are
optional. `Schema.TaggedClass` and `Schema.TaggedError` use Standard Schema
fields, inject `_tag`, and protect reserved error members.

Constructors receive decoded props. `Class.make` and `Schema.make` return
`Result`-backed values; `unsafeMake` is the explicit trusted bypass for
already validated data.

## Decode and construction

```ts
Schema.decodeUnknown(Model)(unknownValue)
Schema.decode(Model)(encodedValue)
Schema.make(Model)(decodedProps)
await Schema.decodeAsync(Model)(encodedValue)
await Schema.makeAsync(Model)(decodedProps)
```

`decodeUnknown` accepts any Standard Schema. `decode` keeps the encoded input
type at the call site. Both class operations construct a real instance after
validation. Expected failure channels include `SchemaDecodeFailure`,
`SchemaConstructionFailure`, `SchemaDefinitionFailure`,
`SchemaExecutionFailure`, and `SchemaAsyncRequired`.

## Encode

```ts
Schema.encode(Model)(instance)
await Schema.encodeAsync(Model)(instance)
Schema.encode(codec)(decodedValue)
```

Encoding is explicit. The package never treats a read-only schema as its own
inverse and never invents a provider encoder. A missing encoder is
`SchemaUnsupportedOperation`; bad output is `SchemaEncodeFailure`, and thrown
or rejected callbacks are `SchemaExecutionFailure`.

## Type inspection

```ts
Schema.Input<typeof Model>
Schema.Output<typeof Model>
Schema.Props<typeof Model>
Schema.Encoded<typeof Model>
Schema.Instance<typeof Model>
Schema.Fields<typeof Model>
Schema.Struct<typeof Model>
```

These helpers inspect Standard Schema projections and remain independent of a
provider's internal types.

## Adapters

Adapters own native schema bridges, object policies, provider class factories,
and provider-specific derivations. The core only sees the Standard Schema
contract.

- [Zod adapter](zod.md)
- [ArkType adapter](arktype.md)
- [Valibot adapter](valibot.md)

## Result and Effect integration

Schema operations are `better-effect` `Effect` values with no Service
requirements. They are ordinary `better-result` values at runtime:

```ts
const program = Effect.gen(function* () {
  const model = yield* Schema.decode(Model)(input)
  return yield* Schema.encode(Model)(model)
})
```

Use `Result.isError` at an imperative boundary or `yield*` inside a generator.
