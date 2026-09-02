# Migrating from zod-class to better-effect-zod

`better-effect-zod@0.1.0` continues the Schema Class API originally shipped as `zod-class@0.2.0`, while aligning its package boundary, failures, and tagged errors with the better-effect ecosystem.

## 1. Replace the dependency

```diff
- "zod-class": "0.2.0"
+ "better-effect-zod": "0.1.0"
```

Install the ecosystem peers explicitly:

```bash
npm install better-effect-zod zod better-result better-effect
```

## 2. Replace the package import

The compatibility facade still works:

```diff
- import { Z } from "zod-class"
+ import { Z } from "better-effect-zod"
```

New code should use `Schema`:

```diff
- import { Z } from "zod-class"
+ import { Schema } from "better-effect-zod"
```

```diff
- class User extends Z.Class<User>("User")({
+ class User extends Schema.Class<User>("@app/User")({
    id: z.uuid()
  }) {}
```

The `Z` runtime value and namespace types are deprecated aliases; they have not been removed.

## 3. Replace unchecked construction

The old public bypass is removed:

```diff
- User.make(props, { disableChecks: true })
+ User.unsafeMake(props)
```

The same applies to constructors:

```diff
- new User(props, { disableChecks: true })
+ User.unsafeMake(props)
```

Normal constructors, `make`, `makeAsync`, `safeMake`, and `safeMakeAsync` always validate decoded props.

`unsafeMake` is deliberately explicit and must be restricted to trusted, already validated internal data.

## 4. Use typed boundaries in application workflows

Native Zod APIs remain unchanged:

```ts
User.parse(input)
User.safeParse(input)
User.decode(input)
User.encode(user)
```

For better-effect workflows, replace local `try/catch` or ad hoc Zod-error mapping with the new operations:

```ts
const user = yield* Schema.decodeUnknown(User)(input)
const wire = yield* Schema.encode(User)(user)
```

The operations return:

```ts
Effect<User, SchemaDecodeFailure, never>
Effect<z.input<typeof User>, SchemaEncodeFailure, never>
Effect<User, SchemaConstructionFailure, never>
```

Async variants return `Promise<Effect<...>>`.

## 5. Update package-contract errors

```diff
- import { ZodClassError } from "zod-class"
+ import { BetterEffectZodError } from "better-effect-zod"
```

`ZodClassError` and `ZodClassErrorCode` remain deprecated aliases.

These errors represent incorrect API usage, such as invalid identifiers, unsupported definitions, illegal derivations, or reserved fields. Invalid user data still produces native `ZodError` through native APIs or a typed schema failure through `Schema.*` operations.

## 6. Review TaggedError behavior

`Schema.TaggedError` now uses `better-result.TaggedError` as its runtime base.

Existing behavior remains:

```ts
error instanceof Error
error._tag
ErrorClass.is(error)
ErrorClass.parse(encoded)
ErrorClass.encode(error)
```

New behavior is available:

```ts
error.match({ ErrorTag: (value) => value })
yield* error
TaggedError.is(error)
```

The following field names are now reserved in tagged-error schemas:

```text
_tag
name
stack
match
toJSON
```

Rename a conflicting domain field before migrating.

## 7. Use stable namespaced identifiers

Identifiers participate in runtime identity and HMR-compatible instance checks. Prefer namespaced values:

```diff
- "User"
+ "@app/domain/User"
```

Do not assign the same identifier and class kind to incompatible models.

## 8. Update CommonJS consumers

The original package exposed CommonJS output. `better-effect-zod` is ESM-only because its better-result peer is ESM-only.

Use ESM imports:

```ts
import { Schema } from "better-effect-zod"
```

A CommonJS application must load the package through dynamic `import()` or migrate its package boundary to ESM.

## 9. Preserve the same model semantics

No migration is required for:

- raw object shapes;
- configured `ZodObject` definitions;
- whole-object `z.codec()` definitions;
- `Schema.Props`, `Fields`, `Struct`, `Encoded`, and `Instance` extraction;
- class derivations;
- metadata and JSON Schema;
- Zod nesting and unions;
- custom constructors that call `super(props)` with the same object.

## Migration checklist

- [ ] Replace the package dependency and imports.
- [ ] Prefer `Schema` over the deprecated `Z` facade.
- [ ] Replace `disableChecks` with explicit `unsafeMake` only where justified.
- [ ] Rename `ZodClassError` imports.
- [ ] Resolve tagged-error fields named `match` or `toJSON`.
- [ ] Confirm the application is ESM-compatible.
- [ ] Adopt typed `Schema.*` operations at untrusted boundaries.
- [ ] Keep repository/network business checks in Effects rather than schemas.
- [ ] Run runtime and type tests after changing identifiers.
