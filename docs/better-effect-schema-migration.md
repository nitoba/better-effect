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

## Audited public API and parity map

The current package was audited from `packages/better-effect-schema/src/index.ts`,
`schema.ts`, `z.ts`, the runtime sources under `src/internal/`, the runtime
`.mjs` tests, the type tests, examples, package scripts, and repository-wide
references. The current implementation is Zod-backed and the entries below
describe the required destination; removal is not considered migration unless
the replacement and behavior are recorded.

| Current export/surface | Current behavior | Destination | Failure/migration rule | Regression coverage |
| --- | --- | --- | --- | --- |
| `Schema`, `Class`, `TaggedClass`, `TaggedError` | Zod-backed class/facade factories | `src/schema.ts`, `src/classes/`, root exports | declaration is lazy/declarative; malformed definitions become `SchemaDefinitionFailure` | class, tagged, and conformance suites |
| `Z` | deprecated alias to the old facade | remove from root after documented cutover; no new alias | historical migration only; never preserve provider coupling | package boundary + migration docs |
| `decodeUnknown` | `z.safeParse` with unknown input | generic Standard Schema operation | `SchemaDecodeFailure` or `SchemaExecutionFailure`; never throw | operations/adversarial tests |
| `decode` | typed `z.input` plus safe decode | generic Standard Schema typed overload | preserve Input inference; same failure union | operation/type tests |
| `decodeUnknownAsync`, `decodeAsync` | `safeParseAsync`/`safeDecodeAsync` | async Standard Schema operation | accept sync/async provider once; observe rejection | async operation tests |
| `encode`, `encodeAsync` | Zod codec output/input conversion | explicit encoder capability | no implicit inverse transform; unsupported is typed | codec/projection tests |
| `make`, `makeAsync` | validates decoded props through class runtime | `Schema.Class` safe factories | return `Result`; capture callback/constructor defects | construction tests |
| `safeMake`, `safeMakeAsync` | Zod safe-parse result shape | remove provider result from public API; use `make` | use `Result.ok`/`Result.err`, not `.success/.data/.error` | construction/type tests |
| `unsafeMake` | bypasses decoded-props validation | retain explicit unsafe factory | only validation is skipped; runtime object identity remains real | unsafe construction tests |
| `new Model(props)` | generated constructor validates in the old implementation | non-validating construction detail only | do not advertise `new` as a validation boundary; package cannot catch consumer code outside a call | class docs + type fixtures |
| `identifier`, `kind`, identity guards | descriptor and prototype markers | portable class identity contract | invalid identifier/tag is a typed definition failure | identity/definition tests |
| `fields`, `struct`, `schema` | Zod object shape/projections | `Fields`/structure capability | available only when declared; no provider internals in root | capability tests |
| `codec`, `encodedSchema`, `propsSchema` | Zod input/output/props projections | explicit codec and construction capabilities | preserve Input/Output/Props distinctions | codec/class tests |
| metadata, `describe`, `register`, `toJSONSchema` | Zod registry/JSON Schema helpers | portable metadata + Standard JSON Schema capability | conversion returns Result; no permissive fallback | JSON Schema tests |
| `extend`, `pick`, `omit`, `partial`, `exactPartial`, `deepPartial`, `required` | native/derived Zod object schemas | generic derivation engine | preserve protected tags, defaults, codecs, refinements | derivation/conformance tests |
| `strict`, `loose`, `strip`, `catchall` | Zod object policies | portable object-policy capability | unsupported provider policy is explicit typed failure | derivation/adapters tests |
| better-result TaggedError integration | schema-backed errors inherit better-result protocol | core `TaggedError` built on better-result | constructing a tagged error is a value; throwing is never the API | tagged/error tests |

### Operation signatures to preserve

The generic signatures are intentionally provider-neutral:

```ts
type SchemaEffect<A, E> = Effect<A, E, never>

decodeUnknown<S extends StandardSchema>(schema: S):
  (input: unknown) => SchemaEffect<Output<S>, SchemaDecodeFailure | SchemaExecutionFailure | SchemaAsyncRequired>

decode<S extends StandardSchema>(schema: S):
  (input: Input<S>) => SchemaEffect<Output<S>, SchemaDecodeFailure | SchemaExecutionFailure | SchemaAsyncRequired>

decodeUnknownAsync<S extends StandardSchema>(schema: S, input: unknown):
  Promise<SchemaEffect<Output<S>, SchemaDecodeFailure | SchemaExecutionFailure>>

make<C extends SchemaClass>(model: C, props: Props<C>):
  SchemaEffect<Instance<C>, SchemaConstructionFailure | SchemaDefinitionFailure | SchemaExecutionFailure>
```

Data-first overloads are equivalent to the data-last forms. Sync operations are
never `Result | Promise`; if a validator returns a thenable, the operation
returns `SchemaAsyncRequired` while attaching a rejection observer to the
already-created thenable. Async operations must not probe by executing a
validator twice.

## Current test, example, and consumer inventory

The source package currently has runtime coverage in:

- `tests/runtime/smoke.test.mjs`, `operations.test.mjs`, `codec.test.mjs`,
  `construction.test.mjs`, `tagged.test.mjs`, `object-modes.test.mjs`, and
  `zod-45.test.mjs`;
- `tests/runtime/failure.test.mjs`, `derivation.test.mjs`,
  `effect-enhancements.test.mjs`, `regressions.test.mjs`,
  `tagged-result.test.mjs`, and `advanced.test.mjs`;
- type fixtures under `tests/types/` and executable examples under `examples/`.

The migration must retain equivalent scenarios, then add generic and negative
capability coverage. The examples currently exercise basic classes, tagged
errors, codecs, derivations, recursive models, Effect workflows, Kysely rows,
and MQ codecs. Kysely/MQ examples must migrate only their schema boundary; they
must not acquire a dependency on the new schema package unless an actual
consumer import exists.

Repository references were classified as follows:

| Reference kind | Current locations | Action |
| --- | --- | --- |
| executable package identity | `package.json`, package scripts, `scripts/check-*.mjs`, release routing | update during #211/#227 |
| source imports | package examples/tests and any `rg` result outside historical docs | migrate semantically in #226 |
| provider-specific implementation | `src/`, `src/internal/`, type imports | move to `src/adapters/zod/` in #220 or replace in core |
| documentation/history | README, API/architecture docs, migration/spec records | update or mark historical; never remove migration guidance blindly |
| original reference fixture | `docs/reference/original-zod-class.ts` | retain as historical comparison, not executable package code |

## Ownership and dependency contract

| Owner | Files/modules | Must not change independently |
| --- | --- | --- |
| integration | root manifest, lockfile, `src/index.ts`, workflows, release routing | provider capability semantics owned by feature branches |
| failures/operations | `failure.ts`, `schema-effect.ts`, `internal/`, `operations/`, `standard/` | adapters and class runtime |
| portable types | `types/`, `capabilities/`, `Schema.with` | provider-specific imports |
| classes | `classes/`, class type fixtures | derivation algorithms and adapters |
| derivations | `derivation/` and object policy tests | tagged/class identity declarations |
| adapters | `adapters/{zod,valibot,arktype}/` and local tests | root barrels, manifest, lockfile |
| JSON Schema | `json-schema/` and metadata tests | provider adapter implementation |
| conformance/release | `tests/conformance/`, external fixtures, `VERIFICATION.md` | production feature implementation |

The dependency order is #210 → #211 → #213 → (#214 and #215) → #216 →
(#217, #220, #221, #222, #224), then #218/#219 → #223, followed by #225/#226
and finally #227. Each completed issue is delivered as its own PR to `main`.

## Baseline evidence

On the current main baseline after a frozen Bun install:

```text
bun install --frozen-lockfile  -> completed with Bun 1.4.2
bun test                        -> 512 passed, 96 failed, 95 module-resolution errors
```

The failures are pre-existing workspace conditions in this fresh worktree:
internal packages such as `better-effect`/`better-effect-mq` are not built for
the source test runner, and `packages/better-effect-schema/dist` is absent before
its package build. One Kysely side-effect test also fails independently. The
baseline is recorded so later package/build gates can distinguish these facts;
no assertion was weakened and no failure was marked as a feature success.

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
