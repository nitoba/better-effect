# Architecture

## Position in the ecosystem

`better-effect-zod` is an optional modeling and validation package:

```text
transport / database / queue value
                 │ unknown or encoded
                 ▼
          better-effect-zod
       decode / encode / classes
                 │ Result<A, E>
                 ▼
            better-result
                 │ workflow + requirements
                 ▼
            better-effect
                 │ adapters
                 ▼
 Kysely / MQ / Better Auth / HTTP boundaries
```

Dependency direction is one-way:

```text
better-effect-zod -> zod
better-effect-zod -> better-result
better-effect-zod -type-only-> better-effect
```

The core `better-effect` package must not import or re-export this package.

## Source layout

### Public modules

- `src/schema.ts` assembles the preferred `Schema` facade.
- `src/z.ts` provides the deprecated `Z` alias.
- `src/class.ts` creates ordinary schema classes.
- `src/tagged-class.ts` creates discriminated data classes.
- `src/tagged-error.ts` creates schema-backed better-result errors.
- `src/operations.ts` exposes Result-backed decode, encode, and construction operations.
- `src/failure.ts` defines typed expected failures.
- `src/is-schema-class.ts` and `src/is-class-instance.ts` provide guards.
- `src/index.ts` is the package entrypoint.
- `src/types.ts` re-exports public types.

### Runtime internals

- `descriptor.ts` stores immutable class descriptors in a `WeakMap`.
- `object-schema.ts` resolves raw shapes, objects, and whole-object codecs.
- `projections.ts` caches Zod input/output projections.
- `runtime-class.ts` builds real JavaScript classes and static construction APIs.
- `construction-context.ts` transports private prevalidated values through constructor chains.
- `instance.ts` validates, copies, extracts, and identifies instance data.
- `codec.ts` creates the concrete bidirectional class codec.
- `codec-cache.ts` owns codec cache lifecycle.
- `proxy.ts` joins constructor statics and the public Zod schema surface.
- `derivation.ts` and `class-derivation-api.ts` implement object transformations.
- `metadata.ts` synchronizes registry metadata.
- `tag.ts` injects and protects tagged fields.
- `issues.ts` sanitizes Zod diagnostics.
- `result.ts` provides the requirement-free Effect facade over Result.
- `symbols.ts` defines type metadata and stable runtime identity symbols.

## Class creation

`Schema.Class<Self>(identifier)(definition)`:

1. validates the logical identifier;
2. resolves the definition into encoded and decoded object projections;
3. freezes and registers a descriptor;
4. selects the JavaScript base class;
5. creates a real generated class;
6. marks its prototype with logical identity and class kind;
7. installs construction, metadata, and derivation statics;
8. creates a narrow constructor/schema facade proxy;
9. lazily creates the concrete Zod codec when first needed.

The returned value is suitable as both a base class and a public Zod schema.

## Why a narrow proxy exists

JavaScript constructors and Zod schemas are different objects. The facade resolves:

- class-owned properties such as `make`, `fields`, and `extend` on the constructor;
- schema-owned properties such as `_zod`, `parse`, `array`, and `optional` on the concrete codec.

Delegated methods are bound and cached per concrete constructor. Zod's `apply` method is preferred over `Function.prototype.apply` when the names collide.

The proxy is deliberately shallow. It does not wrap parsed results, domain objects, schema ASTs, iterators, database builders, or values from other libraries.

## Concrete codec

Each concrete class constructor receives one lazily cached codec:

```text
input side:  original ZodObject or whole-object ZodCodec
output side: z.custom(instance has identifier + kind)
```

Decode:

```text
encoded input
  -> definition decode
  -> decoded props
  -> private prevalidated construction
  -> concrete class instance
```

Encode:

```text
class instance
  -> enumerable own data properties
  -> definition encode
  -> encoded boundary value
```

A user subclass therefore decodes to the actual subclass, not merely to the generated base.

## Decoded construction

Constructors receive decoded properties. Parsing those properties through the encoded definition would be incorrect when a field maps, for example, `string -> Date`.

Normal construction uses the cached `z.output(definition)` projection:

```text
new Model(decodedProps)
  -> propsSchema validation
  -> property assignment
```

`make`, `makeAsync`, `safeMake`, and `safeMakeAsync` use the same decoded-side boundary. `unsafeMake` deliberately enters only the private prevalidated path.

## Private prevalidated context

Decode and async construction already possess validated decoded props. Running validation again inside a custom constructor would be redundant and may fail for asynchronous schemas.

`construction-context.ts` keeps an invocation-local stack keyed by:

- exact concrete constructor;
- exact first-argument object.

The context exists only around `Reflect.construct`. The generated constructor consumes it only when both keys match. No public token or global mutable current value is exposed.

## Result-backed operations

The package does not create another Effect runtime. A schema operation returns a `better-result` Result typed as:

```ts
Effect<Value, Failure, never>
```

The final requirement parameter is declaration-only and always `never`. Synchronous operations remain synchronous; asynchronous operations return a Promise of the same requirement-free Effect.

Only expected `ZodError` outcomes from safe Zod APIs become typed failures. Arbitrary exceptions from application callbacks are defects and remain thrown/rejected.

## Failure safety

Schema failures store stable low-sensitivity fields:

```text
_tag
identifier
fixed public message
bounded sanitized issues
```

The original Zod error is stored under a private non-enumerable symbol and exposed through a typed `cause` getter. Public JSON never contains the cause, stack, rejected value, or original issue message.

Sanitization bounds issue count, code length, path length, path-segment length, and identifier length. Only string and safe-integer paths are retained.

## TaggedError integration

The root runtime base for `Schema.TaggedError` is:

```ts
betterResult.TaggedError(tag)
```

The generated schema class extends that base and therefore inherits the ecosystem protocol without reimplementing it:

```text
Error semantics
_tag
static is
match
Symbol.iterator
base toJSON contract
```

The schema class then adds validation, class identity, Zod delegation, derivation, and encoded representation. Derived schema errors use the ordinary class parent chain, so the better-result base is introduced exactly once. Transport encoding is intentionally separate from the inherited diagnostic `toJSON()` method: `Schema.encode(ErrorClass)` follows the Zod codec, while `toJSON()` keeps better-result semantics unless the application overrides it.

## Inheritance and derivation

Derivation transforms an object schema and invokes the same class factory with the current class as parent.

- `extend` prefers `safeExtend`.
- `pick` automatically retains protected fields.
- `omit` rejects protected fields.
- partial operations do not optionalize protected fields.
- object modes preserve strict, loose, strip, and catchall behavior.
- validation of a derived value completes before parent constructor effects run.

Whole-object codecs do not receive structural derivation methods because their two sides may not share property topology.

## Identity and HMR

Generated prototypes own a non-enumerable marker:

```text
Symbol.for("better-effect-zod/instance")
  -> { identifier, kind }
```

`Symbol.hasInstance`, class `.is`, and the package guard walk the prototype chain. Logical identity survives compatible class re-evaluation and distinguishes ordinary classes, tagged classes, and tagged errors.

## Standard Schema interoperability

The facade exposes the backing Zod codec, including Zod's `~standard` property. Consumers that only require Standard Schema can validate without importing package internals.

Standard Schema describes validation/decode, not automatic persistence of arbitrary class instances. A persistence adapter must call the explicit encoded side and verify its storage constraints.

## Policy enforcement

`scripts/check-source.mjs` rejects:

- TypeScript suppression directives;
- standalone `any` in source;
- legacy Zod parser overrides and parser types;
- direct construction of Zod internals;
- `type-fest`;
- Effect TS dependencies;
- private better-effect or better-result subpath imports.

Package checks also reject stale package identities, private export paths, CommonJS entrypoints, missing peers, and generated source artifacts.
