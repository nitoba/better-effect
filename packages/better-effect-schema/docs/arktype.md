# ArkType adapter

`better-effect-schema/arktype` is the optional ArkType 2 adapter. It mounts
native ArkType capabilities on a local `Schema` facade without adding ArkType
to the provider-neutral core.

```ts
import { type } from 'arktype'
import { Result } from 'better-result'
import { Schema } from 'better-effect-schema'
import { ArkTypeAdapter } from 'better-effect-schema/arktype'

const Local = Schema.with(ArkTypeAdapter)
const User = type({ id: 'string', name: 'string' })

const decoded = Schema.decodeUnknown(User, { id: 'user-1', name: 'Ada' })
if (Result.isError(decoded)) throw decoded.error

const fields = Local.fields(User)
if (Result.isError(fields)) throw fields.error
```

The adapter preserves native field and structure identities, object policies,
encoded projections, and the provider's async boundary. It does not invent an
inverse for a schema without an explicit encoding capability.

Portable class definitions can still use `Schema.Class` with Standard Schema
objects, while ArkType-specific derivations remain on `Local` capabilities.
