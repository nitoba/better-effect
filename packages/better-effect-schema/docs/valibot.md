# Valibot adapter

`better-effect-schema/valibot` is an optional adapter for Valibot 1.x. The
Valibot package is imported only by this subpath; the core entry point remains
provider-neutral.

```ts
import * as v from 'valibot'
import { Schema } from 'better-effect-schema'
import { ValibotAdapter } from 'better-effect-schema/valibot'

const LocalSchema = Schema.with(ValibotAdapter)
const User = v.object({ id: v.string() })
const fields = LocalSchema.fields(User)
```

## Capability matrix

The matrix describes the native Valibot 1.4 surface tested by this package.

| Capability                   | Status        | Semantics                                                                                                                                                                                                                         |
| ---------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`                       | Supported     | Accepts native Valibot Standard Schemas and rejects foreign definitions.                                                                                                                                                          |
| `bridge`                     | Supported     | Returns the validated native schema without running it again.                                                                                                                                                                     |
| `props` / `make`             | Supported     | Validates `propsSchema` through Standard Schema, preserves `ConstructionInput`, then calls `construct` with normalized props.                                                                                                     |
| `fields`                     | Supported     | Reads entries from `object`, `looseObject`, `strictObject`, and `objectWithRest`.                                                                                                                                                 |
| `struct` / `extend`          | Supported     | Rebuilds the same object policy while retaining native field schemas.                                                                                                                                                             |
| `pick` / `omit`              | Supported     | Supports key arrays and `{ keys: { field: true } }` masks; unknown fields are definition failures.                                                                                                                                |
| `partial`                    | Supported     | Delegates to Valibot so existing defaults and native optional semantics remain intact.                                                                                                                                            |
| `exactPartial`               | Supported     | Uses exact optional fields and leaves already-optional fields unchanged, preserving defaults.                                                                                                                                     |
| `deepPartial`                | Supported     | Recursively optionalizes objects, arrays, nullable/optional wrappers, and lazy structures when their native shapes are available.                                                                                                 |
| `required`                   | Supported     | Delegates to the matching sync or async Valibot constructor.                                                                                                                                                                      |
| `strict` / `loose` / `strip` | Supported     | Maps to the corresponding Valibot object constructor.                                                                                                                                                                             |
| `catchall`                   | Conditional   | Preserves an existing `objectWithRest` rest schema; a bare object has no rest schema to infer, so the operation returns a typed unsupported failure.                                                                              |
| `encoded`                    | Conservative  | Projects structural schemas to their Input side and removes defaults. Validation and read-only pipeline actions are retained; transformations, fallbacks, and other output-changing pipelines return a typed unsupported failure. |
| `encode` / `encodeAsync`     | Explicit only | No inverse is invented. Supply an encoder with `ValibotAdapter.withEncoder`; throws and rejections become typed failures.                                                                                                         |
| JSON Schema                  | Unsupported   | Valibot's optional converter is not a dependency of this adapter, so no `toJSONSchema` capability is mounted.                                                                                                                     |

Async Valibot schemas are accepted by `read` and derived constructors choose
the async native operation. Synchronous facade calls report
`SchemaAsyncRequired`; use the corresponding async schema validation or
`encodeAsync` boundary.

Object-level transformations and checks are not silently copied into
structural derivations. They return `SchemaUnsupportedOperation` because
changing the object shape could invalidate their assumptions. Input-preserving
validation and read-only actions remain available through `encoded`.
