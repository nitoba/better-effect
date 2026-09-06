# better-effect-schema migration contract

This document is the implementation contract for roadmap #209. It is based on
the public surface of `better-effect-zod` at the audited baseline and the
provider-neutral decisions in issue #209.

## Migration rules

| Legacy surface | `better-effect-schema` destination |
| --- | --- |
| `better-effect-zod` import | `better-effect-schema`, plus an optional adapter only when a capability needs one |
| `decode*` / `encode*` throwing provider calls | `Schema.decode*` / `Schema.encode*` returning `Result` through `SchemaEffect` |
| `new Model(props)` as validation | `Model.make(props)` / `makeAsync(props)` returning a Result |
| Zod safe-parse result | `better-result` `Result.ok` / `Result.err` |
| Zod-specific error type | operation-specific `Schema*Failure` |
| implicit encoding | explicit codec/encoder capability |
| class used as a provider-specific schema | Standard Schema protocol or an explicit bridge |

## Stable contracts

```ts
type SchemaEffect<A, E> = Effect<A, E, never>

Schema.decodeUnknown(schema, input): SchemaEffect<Schema.Output<typeof schema>, DecodeErrors>
Schema.decodeUnknownAsync(schema, input): Promise<SchemaEffect<Schema.Output<typeof schema>, DecodeErrors>>
Schema.toJSONSchema(schema, options): SchemaEffect<JsonSchemaDocument, ConversionErrors>
```

The sync API never returns a Promise. A Promise returned by a provider is
observed and reported as `SchemaAsyncRequired`; the async API accepts either
sync or async validators and executes them once. Standard Schema's native
`~standard.validate` return shape is preserved at the protocol boundary and is
converted to `Result` only by package operations.

`Schema.Input`, `Schema.Output`, `Schema.Props`, `Schema.Instance`, and
`Schema.Encoded` remain distinct where defaults, transforms, or construction
make them distinct. A class builder is declarative and may retain a definition
failure; `Schema.check` and operations surface that failure instead of making a
permissive fallback schema.

## Failure policy

The package exports operation-specific tagged failures:

`SchemaDecodeFailure`, `SchemaEncodeFailure`, `SchemaConstructionFailure`,
`SchemaDefinitionFailure`, `SchemaExecutionFailure`,
`SchemaUnsupportedOperation`, and `SchemaAsyncRequired`.

Provider issues are normalized to bounded paths and messages. The original
`cause: unknown` is retained only in memory as a non-enumerable property. JSON
diagnostics omit payloads, stacks, causes, and arbitrary provider messages by
default. The normalizer must remain safe for cycles, BigInt, symbols, hostile
getters, proxies, and custom serialization.

## Capability matrix

Standard Schema guarantees validation only. Encoding, field introspection,
props construction, structural derivation, and JSON Schema require explicit
capabilities. Each adapter documents the capabilities it actually supports;
missing or non-preservable operations return `SchemaUnsupportedOperation`.

| Capability | Core protocol | Zod adapter | Valibot adapter | ArkType adapter |
| --- | --- | --- | --- | --- |
| sync/async decode | yes | yes | yes | yes |
| explicit encoding | capability | supported where lossless | supported where lossless | provider-dependent |
| fields/props | capability | adapter | adapter | adapter |
| classes | core | bridge/native adapter | bridge/native adapter | bridge/native adapter |
| derivation | core engine from capabilities | native adapter where safe | supported subset | supported subset |
| JSON Schema | Standard JSON Schema/capability | adapter/converter | adapter/converter | adapter/converter |

This matrix is intentionally conservative: a provider feature is never inferred
from a vendor name, a private field, or an inverse transform.

## Examples

### Generic Standard Schema

```ts
const Positive = {
  "~standard": {
    version: 1,
    vendor: "example",
    validate(value: unknown) {
      return typeof value === "number" && value > 0
        ? { value }
        : { issues: [{ message: "Expected a positive number" }] }
    }
  }
}

const result = Schema.decodeUnknown(Positive, 3)
```

### Result-returning class construction

```ts
class User extends Schema.Class<User>("User")({
  schema: UserInput,
  propsSchema: UserProps
}) {
  greeting() {
    return `Hello ${this.name}`
  }
}

const user = User.make({ name: "Ada" })
```

### Explicit provider capability

```ts
const Local = Schema.with(ZodAdapter)
const encoded = Local.encode(DateModel, new Date())
```

The exact adapter methods are capability-gated and return a typed Result; no
provider-specific safe-parse object or throwing parse function crosses the
public facade.
