# Zod Schema Class Design

> Historical design for `zod-class@0.2.0`. The current package contract is defined by the 2026-09-02 better-effect-zod integration design.

**Date:** 2026-09-01
**Status:** Superseded by `2026-09-02-better-effect-zod-integration-design.md`
**Target:** Zod >=4.5.4 <5, TypeScript 6.x (source-compatible with the local TypeScript 5.8 verifier)

## Problem

The original implementation turns classes into Zod schemas by implementing legacy parser internals, manually recreating `input` and `output` inference, constructing Zod wrappers directly, copying PascalCase fields onto constructors, and allocating instances with `Object.create`. This tightly couples the library to old Zod internals and prevents accurate modeling of bidirectional fields such as `string <-> Date`.

## Goals

- Provide an Effect-inspired class API where a class is also accepted anywhere a classic Zod schema is accepted.
- Model three distinct types: encoded input, decoded constructor props, and class instance output.
- Use Zod 4 codecs for real bidirectional decode/encode behavior.
- Validate decoded props in constructors and `make`, with an explicit `disableChecks` escape hatch.
- Support class derivation (`extend`, `pick`, `omit`, `partial`, `required`).
- Support `TaggedClass` and real JavaScript `Error` subclasses through `TaggedError`.
- Preserve identity across hot module replacement through stable symbols and identifiers.
- Keep the implementation split into small, independently testable modules.
- Publish ESM and CommonJS builds with declarations and no runtime dependency besides peer `zod`.

## Non-goals

- Supporting Zod 3.
- Supporting Zod Mini as a first-class target in the initial release.
- Reproducing Effect runtime behavior such as yieldable errors.
- Mirroring every `ZodObject` derivation operation as a class operation.
- Generating PascalCase static fields (`Person.Name`). Fields are exposed through `Person.fields.name`.

## Public API

### Class

```ts
import { z } from "zod"
import { Z } from "zod-class"

const DateFromISOString = z.codec(z.iso.datetime(), z.date(), {
  decode: (value) => new Date(value),
  encode: (value) => value.toISOString()
})

class Person extends Z.Class<Person>("Person")({
  id: z.int().positive(),
  name: z.string().min(1),
  bornAt: DateFromISOString
}) {
  get label() {
    return `${this.name} #${this.id}`
  }
}
```

The class constructor and `make` receive decoded props:

```ts
const person = new Person({
  id: 1,
  name: "Ada",
  bornAt: new Date("1990-12-10T00:00:00.000Z")
})
```

Decode and encode use the external representation:

```ts
const decoded = Person.decode({
  id: 1,
  name: "Ada",
  bornAt: "1990-12-10T00:00:00.000Z"
})

const encoded = Person.encode(decoded)
```

The class is a schema:

```ts
const People = z.array(Person)
```

### Static surface

Every generated class exposes:

- `identifier`
- `fields`
- `struct`
- `schema`
- `make`, `makeAsync`
- `is`
- `extend`, `pick`, `omit`, `partial`, `required`
- Zod schema methods and internals delegated to a real class codec, including parse/decode/encode and wrappers
- `meta`, `describe`, and `register`

### Type helpers

```ts
type Encoded = z.input<typeof Person>
type Instance = z.output<typeof Person>
type Props = Z.Props<typeof Person>
type Fields = Z.Fields<typeof Person>
```

`Encoded` is the external object, `Props` is the decoded object accepted by construction, and `Instance` is the class instance.

### Derivation

```ts
class Employee extends Person.extend<Employee>("Employee")({
  role: z.enum(["admin", "member"])
}) {}

class PersonSummary extends Person.pick<PersonSummary>("PersonSummary")({
  id: true,
  name: true
}) {}
```

Derived classes inherit instance methods from their parent and receive their own identifier and codec.

### Tagged classes and errors

```ts
class UserCreated extends Z.TaggedClass<UserCreated>()(
  "UserCreated",
  { userId: z.uuid() }
) {}

class UserNotFound extends Z.TaggedError<UserNotFound>()(
  "UserNotFound",
  { userId: z.uuid() }
) {
  override get message() {
    return `User ${this.userId} was not found`
  }
}
```

The caller does not pass `_tag`; it is injected by the constructor. The encoded form includes `_tag`.

## Architecture

### Real codec, class facade

Each concrete class has a lazily-created `z.codec`:

```text
encoded struct
  -> decode fields/refinements
  -> decoded props
  -> construct class with checks disabled
  -> class instance

class instance
  -> extract own data fields
  -> encode fields/refinements
  -> encoded struct
```

The generated class is wrapped in a `Proxy`. Properties implemented by the class API are resolved normally. Missing schema properties and methods are delegated to the lazily-created codec for the concrete receiver. This avoids subclassing Zod internals while preserving compatibility with combinators that inspect `_zod`.

### Descriptor registry

A `WeakMap<Function, ClassDescriptor>` stores immutable class metadata:

- identifier
- object schema
- effective object fields
- parent constructor
- tag/error flags
- annotations

Descriptors are looked up through the concrete constructor, not closed over by the base class, so subclasses get correct behavior.

### Construction validation

Decoded props are validated with the runtime `z.output(struct)` projection introduced in Zod 4.5:

1. Create and cache the struct's output-side schema.
2. Parse decoded props directly with that projection.
3. Assign the validated result to the instance.

This validates output-side codecs and checks without treating decoded values as network input or performing an encode/decode round trip. Nested schema-class instances preserve reference identity. `makeAsync` parses the same projection asynchronously. The constructor is synchronous; when the output projection contains asynchronous checks, Zod reports that synchronous parsing is unavailable and callers must use `makeAsync`.

`{ disableChecks: true }` skips validation but still normalizes injected tagged fields.

### Identity and HMR

Each generated prototype owns a marker keyed by a global symbol. The marker stores both the identifier and class kind. `Class.is(value)` traverses the prototype chain and compares both values. Re-evaluating a class definition with the same identifier and kind therefore recognizes existing instances without making ordinary classes, tagged classes, and tagged errors interchangeable.

### Metadata and JSON Schema

The class facade and underlying codec are registered in `z.globalRegistry`. By default, the identifier is stored as metadata `title`, not as the globally unique registry `id`, so classes may be recreated safely during HMR. When callers provide an explicit `id`, that ID belongs to the concrete class facade and is omitted from the backing codec metadata to avoid a registry collision. JSON Schema is generated from the input side by default:

```ts
z.toJSONSchema(Person, { io: "input" })
```

### Error behavior

- Invalid encoded data throws `ZodError` from decode/parse.
- Invalid decoded construction props throw `ZodError` from the output-side struct projection.
- Encoding a non-instance is rejected by the output-side instance schema.
- Invalid class definitions and impossible derivations throw `ZodClassError` with stable error codes.

## Source layout

```text
src/
  index.ts
  z.ts
  class.ts
  tagged-class.ts
  tagged-error.ts
  types.ts
  types/
    common.ts
    class-metadata.ts
    shapes.ts
    derivation-builders.ts
    schema-class.ts
    factories.ts
    tagged.ts
    extractors.ts
  errors.ts
  internal/
    symbols.ts
    class-types.ts
    descriptor.ts
    object-schema.ts
    output-projection.ts
    instance.ts
    construction-context.ts
    codec-cache.ts
    codec.ts
    metadata.ts
    proxy.ts
    class-schema-api.ts
    derivation.ts
    class-derivation-api.ts
    runtime-class.ts
    factory.ts
    tag.ts
```

Each internal file owns one concern. Public entry files are thin adapters and exports.

## Testing

Runtime tests use Node's test runner against an installed Zod 4.5.x and cover:

- constructor and factory validation
- encoded/decoded codecs
- class-as-schema composition
- safe parse/encode/decode and async variants
- inheritance and derivations
- tagged classes and errors
- metadata and JSON Schema
- recursion
- empty classes
- stable identity/HMR
- error paths

Type tests use `tsc --noEmit` and `@ts-expect-error` to verify encoded, props, instance, derivation, and constructor inference.

## Compatibility

- Node.js 20+
- TypeScript 6.x target
- Zod `>=4.5.4 <5`
- ESM and CommonJS consumers
