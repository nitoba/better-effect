# better-effect-zod

**Zod schema classes and typed validation boundaries for the better-effect ecosystem.**

`better-effect-zod` turns Zod object schemas and bidirectional codecs into real TypeScript classes. The same declaration can validate encoded input, construct domain objects, preserve class behavior, and encode instances back to a boundary representation.

It also adds requirement-free operations that return `better-result` values typed as `better-effect` Effects:

```text
unknown / encoded value
          │
          ▼
Schema.decodeUnknown(...)
          │
          ├── Effect<Domain, SchemaDecodeFailure, never>
          ▼
real domain class instance
```

The package is optional and independent. It does not add Zod to `better-effect` core, does not create another Effect runtime, and does not hide Service requirements inside schema callbacks.

## Installation

```bash
npm install better-effect-zod zod better-result better-effect
```

```bash
bun add better-effect-zod zod better-result better-effect
```

Compatibility targets:

- Zod `>=4.5.4 <5`
- better-result `^3.0.0`
- better-effect `>=0.13.0 <0.14.0`
- TypeScript `>=5.7.0`
- Node.js `>=20`

The package is ESM-only.

## Quick start

```ts
import * as z from "zod"
import { Schema } from "better-effect-zod"

const DateFromISOString = z.codec(
  z.iso.datetime(),
  z.date(),
  {
    decode: (value) => new Date(value),
    encode: (value) => value.toISOString()
  }
)

class Person extends Schema.Class<Person>("@app/domain/Person")({
  id: z.int().positive(),
  name: z.string().min(1),
  bornAt: DateFromISOString
}) {
  get label(): string {
    return `${this.name} #${this.id}`
  }
}

const person = Person.parse({
  id: 1,
  name: "Ada",
  bornAt: "1990-12-10T00:00:00.000Z"
})

person instanceof Person // true
person.bornAt instanceof Date // true
person.label // "Ada #1"

Person.encode(person)
// { id: 1, name: "Ada", bornAt: "1990-12-10T00:00:00.000Z" }
```

`Schema` is the preferred facade. The original `Z` facade remains available as a deprecated alias for migration.

## The three-type model

A schema class represents three related types:

| Type | Meaning | `Person` example |
| --- | --- | --- |
| `z.input<typeof Person>` | Encoded boundary input | `bornAt: string` |
| `Schema.Props<typeof Person>` | Decoded constructor properties | `bornAt: Date` |
| `z.output<typeof Person>` | Concrete class instance | `Person` |

```ts
type PersonEncoded = z.input<typeof Person>
type PersonProps = Schema.Props<typeof Person>
type PersonInstance = z.output<typeof Person>
```

The distinction is important whenever a field or whole object uses `z.codec()`. One-way transforms are suitable only when reverse encoding is not required.

## Native Zod APIs and typed Effect boundaries

Schema classes retain the standard Zod surface:

```ts
Person.parse(input)             // throws ZodError
Person.safeParse(input)         // Zod safe result
Person.decode(encoded)          // throws ZodError
Person.encode(person)           // throws ZodError
await Person.decodeAsync(input)
await Person.encodeAsync(person)
```

Use these operations when native Zod behavior is the desired boundary.

For application workflows, the `Schema` facade exposes expected failures as `better-result` values:

```ts
import type { Effect } from "better-effect"
import {
  Schema,
  SchemaDecodeFailure,
  SchemaEncodeFailure
} from "better-effect-zod"

const decoded = Schema.decodeUnknown(Person)(input)
// Effect<Person, SchemaDecodeFailure, never>

const encoded = Schema.encode(Person)(person)
// Effect<PersonEncoded, SchemaEncodeFailure, never>
```

These operations are requirement-free. Their runtime representation is a `better-result` `Result`; `Effect<_, _, never>` records that no Service is acquired.

### Available operations

```ts
Schema.decodeUnknown(schema)(unknownValue)
Schema.decode(schema)(encodedValue)
Schema.decodeUnknownAsync(schema)(unknownValue)
Schema.decodeAsync(schema)(encodedValue)

Schema.encode(schema)(decodedValue)
Schema.encodeAsync(schema)(decodedValue)

Schema.make(SchemaClass)(decodedProps)
Schema.makeAsync(SchemaClass)(decodedProps)
```

Every operation also supports a data-first form:

```ts
Schema.decodeUnknown(Person, input)
Schema.encode(Person, person)
Schema.make(Person, props)
```

### Composition with Result.gen and Effect.fn

```ts
import { Effect } from "better-effect"
import { Result } from "better-result"
import { Schema } from "better-effect-zod"

const normalizePerson = (input: unknown) =>
  Effect.fn(function* () {
    const person = yield* Schema.decodeUnknown(Person)(input)
    const encoded = yield* Schema.encode(Person)(person)

    return Result.ok(encoded)
  })
```

Schema failures participate in the same short-circuiting model as every other `better-result` failure. Business logic can then resolve Services normally:

```ts
const createPerson = (input: unknown) =>
  Effect.fn(async function* () {
    const person = yield* Schema.decodeUnknown(Person)(input)
    const repository = yield* PersonRepository
    const saved = yield* Result.await(repository.save(person))

    return Result.ok(saved)
  })
```

The schema remains pure; `PersonRepository` stays visible in the Effect requirement channel.

## Typed schema failures

Expected validation failures use the ecosystem's `TaggedError` protocol:

```ts
SchemaDecodeFailure
SchemaEncodeFailure
SchemaConstructionFailure
```

Each failure includes a bounded, serialization-safe representation:

```ts
{
  _tag: "SchemaDecodeFailure",
  name: "SchemaDecodeFailure",
  message: "Schema decoding failed",
  identifier: "@app/domain/Person",
  issues: [
    { code: "invalid_type", path: ["name"], message: "Validation failed" }
  ]
}
```

The original `ZodError` remains available as `failure.cause` in memory. It is non-enumerable and excluded from `toJSON()`. Rejected values, stacks, arbitrary error messages, and complete payloads are not copied into the public failure envelope.

Handle failures with the ordinary better-result matching tools:

```ts
const response = result.match({
  ok: (person) => ({ status: 200, person }),
  err: (failure) => failure.match({
    SchemaDecodeFailure: (error) => ({
      status: 400,
      issues: error.issues
    })
  })
})
```

Package-contract misuse is different from invalid user data. Invalid identifiers, unsupported definitions, illegal derivations, and reserved fields throw `BetterEffectZodError` because they represent programming defects.

## Construction

Constructors and `make` accept decoded properties:

```ts
const props: Schema.Props<typeof Person> = {
  id: 1,
  name: "Ada",
  bornAt: new Date("1990-12-10T00:00:00.000Z")
}

const first = new Person(props)
const second = Person.make(props)
```

Both validate the decoded side through Zod's `z.output(...)` projection. Defaults, decoded-side refinements, object policies, and nested schema classes remain active without encoding and decoding the value again.

Safe and asynchronous construction are also available:

```ts
const safe = Person.safeMake(props)
const asyncSafe = await Person.safeMakeAsync(props)
const asyncPerson = await Person.makeAsync(props)
```

### Explicit unsafe construction

Normal constructors and `make` always validate. A trusted internal path can opt out only through the visibly unsafe API:

```ts
const trusted = Person.unsafeMake(props)
```

`unsafeMake` skips schema checks but still creates the correct class identity and injects protected tags. It must not be used for untrusted input.

A custom constructor should forward the same properties object to `super`:

```ts
class Account extends Schema.Class<Account>("@app/Account")({
  id: z.string()
}) {
  constructor(props: Schema.Props<typeof Account>) {
    super(props)
    // custom initialization
  }
}
```

This allows parse/decode and asynchronous construction to reuse already validated properties without repeating synchronous validation.

## A class is still a Zod schema

Schema classes can be nested wherever a classic Zod schema is accepted:

```ts
const People = z.array(Person)

const Team = z.object({
  name: z.string(),
  members: z.array(Person)
})

const OptionalPerson = Person.optional()
const PersonOrNull = Person.nullable()
```

Nested parsing still creates concrete instances:

```ts
const team = Team.parse({
  name: "Research",
  members: [{
    id: 1,
    name: "Ada",
    bornAt: "1990-12-10T00:00:00.000Z"
  }]
})

team.members[0] instanceof Person // true
```

The class facade exposes the concrete codec contract, including Zod 4.5 fast-path APIs:

```ts
const CompiledPerson = z.compile(Person)
const person = CompiledPerson.parse(input)
const valid = z.validate(Person, input)
```

No Zod parser internals are reimplemented or imported through private paths.

## Whole-object codecs

A class may be backed by a complete bidirectional object codec:

```ts
const UserWireCodec = z.codec(
  z.object({
    user_id: z.uuid(),
    display_name: z.string(),
    created_at: z.iso.datetime()
  }),
  z.object({
    id: z.uuid(),
    displayName: z.string(),
    createdAt: z.date()
  }),
  {
    decode: (row) => ({
      id: row.user_id,
      displayName: row.display_name,
      createdAt: new Date(row.created_at)
    }),
    encode: (user) => ({
      user_id: user.id,
      display_name: user.displayName,
      created_at: user.createdAt.toISOString()
    })
  }
)

class User extends Schema.Class<User>("@app/domain/User")(UserWireCodec) {
  get label(): string {
    return this.displayName
  }
}
```

`User.parse(...)` accepts the wire object, constructors accept decoded props, and `User.encode(...)` restores the wire representation.

Arbitrary whole-object codecs cannot use structural class derivations. A codec may rename, synthesize, merge, or remove fields, so a generic `pick`, `omit`, or `partial` cannot safely preserve its inverse mapping. Define or compose another codec instead.

## Tagged classes

`Schema.TaggedClass` injects and protects a literal `_tag`:

```ts
class UserCreated extends Schema.TaggedClass<UserCreated>()(
  "UserCreated",
  { userId: z.uuid() }
) {}

const event = UserCreated.parse({
  _tag: "UserCreated",
  userId: "550e8400-e29b-41d4-a716-446655440000"
})
```

Constructors do not require the tag:

```ts
new UserCreated({
  userId: "550e8400-e29b-41d4-a716-446655440000"
})
```

The encoded form always contains `_tag`. Derivations cannot replace, remove, or optionalize it.

## Schema-backed better-result TaggedError

`Schema.TaggedError` uses `better-result.TaggedError(tag)` as its JavaScript base. It is simultaneously:

- a real `Error`;
- a Zod schema class;
- a `better-result.AnyTaggedError`;
- directly yieldable in `Result.gen` and `Effect.gen`;
- exhaustively matchable through `.match(...)`.

```ts
class UserNotFound extends Schema.TaggedError<UserNotFound>()(
  "UserNotFound",
  { userId: z.uuid() }
) {
  override get message(): string {
    return `User ${this.userId} was not found`
  }
}

const failure = new UserNotFound({
  userId: "550e8400-e29b-41d4-a716-446655440000"
})

failure instanceof Error // true
UserNotFound.is(failure) // true
failure.match({
  UserNotFound: ({ userId }) => userId
})
```

Direct short-circuiting uses the same object identity:

```ts
const program = Result.gen(function* () {
  yield* failure
  return Result.ok("unreachable")
})
```

Decoded errors retain the same matching and yieldability behavior. `_tag`, `name`, `stack`, `match`, and `toJSON` are reserved schema field names.

For transport or persistence, prefer `Schema.encode(ErrorClass)(error)`. The inherited `better-result` `toJSON()` contract is intended for ordinary error diagnostics and may include error metadata such as a stack or an explicitly supplied cause. Override `toJSON()` in the class body when the application needs a stricter diagnostic envelope; schema fields still cannot replace the protocol method.

## Derivation

Object-backed classes support structural derivation while retaining class behavior:

```ts
class Employee extends Person.extend<Employee>("@app/Employee")({
  role: z.enum(["admin", "member"])
}) {}

class PersonSummary extends Person.pick<PersonSummary>("@app/PersonSummary")({
  id: true,
  name: true
}) {}

class PersonPatch extends Person.partial<PersonPatch>("@app/PersonPatch") {}
```

Available derivations:

```ts
Class.extend(...)
Class.pick(...)
Class.omit(...)
Class.partial(...)
Class.exactPartial(...)
Class.deepPartial(...)
Class.required(...)
Class.strict(...)
Class.loose(...)
Class.strip(...)
Class.catchall(...)
```

A derived class inherits methods and getters. Be deliberate when deriving DTOs: a parent method may depend on a field removed by `pick` or `omit`. For unrelated transport models, defining an independent class is often clearer.

## Static class surface

Every schema class exposes:

```ts
Model.identifier
Model.fields
Model.struct
Model.schema
Model.codec
Model.encodedSchema
Model.propsSchema
Model.kind

Model.make(props)
Model.unsafeMake(props)
Model.makeAsync(props)
Model.safeMake(props)
Model.safeMakeAsync(props)
Model.is(value)

Model.extend(...)
Model.pick(...)
Model.omit(...)
Model.partial(...)
Model.exactPartial(...)
Model.deepPartial(...)
Model.required(...)
Model.strict(...)
Model.loose(...)
Model.strip(...)
Model.catchall(...)

Model.meta(...)
Model.describe(...)
Model.register(...)
Model.toJSONSchema(...)
```

Normal Zod operations such as `parse`, `safeParse`, `decode`, `encode`, `array`, `optional`, `nullable`, `or`, `and`, `pipe`, and `refine` are delegated through the backing codec.

## Ecosystem recipes

### Kysely: decode rows after query execution

Kysely remains the query builder and executor. Decode only after its better-effect terminal returns a row:

```ts
const findUser = (id: string) =>
  Effect.fn(async function* () {
    const db = yield* Database

    const row = yield* db
      .selectFrom("users")
      .selectAll()
      .where("id", "=", id)
      .$call(
        KyselyEffect.executeTakeFirstOrFail(
          () => new UserNotFound({ userId: id })
        )
      )

    const user = yield* Schema.decodeUnknown(User)(row)
    return Result.ok(user)
  })
```

This keeps Kysely inference and execution native while making row-to-domain conversion an explicit typed boundary.

### better-effect-mq: Standard Schema plus explicit encoding

A schema class is a Zod schema and therefore exposes Zod's Standard Schema contract. It can be used as the decode side of `Codec.standardSchema`.

Class instances are not assumed to be JSON-safe. Supply an explicit encoder that delegates to the class's encoded side and maps any failure to the MQ codec failure expected by your job definition:

```ts
const UserPayload = Codec.standardSchema({
  schema: User,
  encode: (user) => mapUserEncodingForJob(
    Schema.encode(User)(user)
  )
})
```

The mapping function is application policy: it decides how schema failures are represented by `JobEncodeFailure` without persisting rejected values or arbitrary causes. `better-effect-mq` remains independent from Zod.

### Hono, Next.js, and Web APIs

Parse transport syntax first, then validate the resulting unknown value:

```ts
const raw = await request.json()
const input = Schema.decodeUnknown(CreateUserRequest)(raw)
```

Mapping `SchemaDecodeFailure` to HTTP 400 belongs to the HTTP adapter or application boundary. This package does not know about status codes, headers, or response envelopes.

## Structural validation versus business rules

Keep deterministic structure and representation rules in schemas:

```text
UUID and email syntax
required fields
string -> Date codecs
snake_case -> camelCase codecs
discriminated unions
local cross-field refinements
```

Keep contextual rules in Effects:

```text
email already exists
user is authorized
account is blocked
inventory is available
record exists in the database
current time or external service checks
```

Do not hide repository or network access inside `superRefine` merely because Zod supports asynchronous callbacks. Doing so erases the Service requirement from the application type and makes the schema process-dependent.

## Runtime identity and HMR

Instances carry a non-enumerable marker under a global symbol containing the logical identifier and class kind. Instance checks walk the prototype chain, which gives two useful properties:

- derived instances satisfy parent checks;
- a re-evaluated class with the same identifier can recognize older instances.

Identifiers are therefore runtime type identities within a class kind. Use stable, namespaced identifiers such as `@acme/domain/User` and do not reuse one identifier for incompatible models.

## Metadata and JSON Schema

Metadata is synchronized between the class facade and its backing codec:

```ts
const DescribedUser = User.describe("Application user")
const metadata = DescribedUser.meta()
```

`Model.toJSONSchema()` defaults to the encoded input side, which is normally the representation useful at an external boundary. `Model.encodedSchema` and `Model.propsSchema` expose the pure input and decoded-property projections without constructing class instances.

## Compatibility aliases

The following source-compatible aliases are retained for migration:

```ts
import { Z, ZodClassError } from "better-effect-zod"
```

They are deprecated:

- use `Schema` instead of `Z`;
- use `BetterEffectZodError` instead of `ZodClassError`;
- use `unsafeMake(props)` instead of `{ disableChecks: true }`.

See [`MIGRATION.md`](./MIGRATION.md) for the complete migration checklist.

## Design constraints

`better-effect-zod` intentionally does not:

- reimplement Effect Schema or its AST;
- create a schema environment or acquire Services;
- import `effect` or `@effect/*`;
- add Zod to `better-effect` core;
- patch Zod prototypes or globals;
- import private Zod paths;
- serialize arbitrary `Date`, `Error`, `Map`, `Set`, `bigint`, or class values magically;
- ship Kysely, MQ, Hono, or Next.js runtime adapters in the initial package.

The package uses a narrow class/schema facade proxy. It does not recursively proxy schema results, user objects, AST values, iterators, or external library instances.

## Development

```bash
npm run typecheck
npm run build
npm run test:runtime
npm run test:types
npm run examples
npm run check
```

The repository includes source-policy, package-boundary, runtime, type, example, and archive checks. See [`VERIFICATION.md`](./VERIFICATION.md) for the exact evidence recorded for this source archive.

## License

MIT
