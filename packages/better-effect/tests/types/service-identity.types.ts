import { expectTypeOf } from 'bun:test'

import { Result } from 'better-result'

import { Effect } from '../../src/effect'
import {
  type CompleteLayer,
  Layer,
  type LayerMissing,
  type LayerProvided,
  type LayerRawRequired
} from '../../src/layer'
import type { MissingServices } from '../../src/layer/inference'
import { Runtime } from '../../src/runtime'
import { Service, type ServiceContract, type ServiceToken } from '../../src/service'

class EmptyPrimary extends Service<EmptyPrimary>()('EmptyPrimary') {}

class EmptyReplica extends Service<EmptyReplica>()('EmptyReplica') {}

// @ts-expect-error Same-shaped Service instances with different tags are incompatible.
const incompatibleEmptyPrimary: EmptyPrimary = new EmptyReplica()
expectTypeOf<typeof EmptyPrimary.serviceTag>().toEqualTypeOf<'EmptyPrimary'>()
expectTypeOf<typeof EmptyReplica.serviceTag>().toEqualTypeOf<'EmptyReplica'>()

class PrimaryDatabase extends Service<PrimaryDatabase>()('PrimaryDatabase') {
  query(sql: string): Promise<string> {
    return Promise.resolve(sql)
  }
}

class ReplicaDatabase extends Service<ReplicaDatabase>()('ReplicaDatabase') {
  query(sql: string): Promise<string> {
    return Promise.resolve(sql)
  }
}

// @ts-expect-error Same-shaped Service instances with different tags are incompatible.
const incompatiblePrimaryDatabase: PrimaryDatabase = new ReplicaDatabase()

class SameTagLeft extends Service<SameTagLeft>()('SameTag') {
  static readonly left = true

  constructor(_value: string) {
    super()
  }

  self(): SameTagLeft {
    return this
  }

  promise(): Promise<SameTagLeft> {
    return Promise.resolve(this)
  }
}

class SameTagRight extends Service<SameTagRight>()('SameTag') {
  static readonly right = true

  constructor(_value: number) {
    super()
  }

  self(): SameTagRight {
    return this
  }

  promise(): Promise<SameTagRight> {
    return Promise.resolve(this)
  }
}

declare const sameTagLeft: ServiceContract<SameTagLeft>
declare const sameTagRight: ServiceContract<SameTagRight>

const sameTagRightFromLeft: ServiceContract<SameTagRight> = sameTagLeft
const sameTagLeftFromRight: ServiceContract<SameTagLeft> = sameTagRight

void incompatibleEmptyPrimary
void incompatiblePrimaryDatabase
void sameTagRightFromLeft
void sameTagLeftFromRight

class NeedsPrimaryDatabase extends Service<NeedsPrimaryDatabase>()('NeedsPrimaryDatabase') {
  use() {
    return Effect.gen(async function* () {
      const database = yield* PrimaryDatabase

      return Result.ok(database)
    })
  }
}

const NeedsPrimaryDatabaseLive = Layer.make(NeedsPrimaryDatabase, () => new NeedsPrimaryDatabase())
const ReplicaDatabaseLive = Layer.make(ReplicaDatabase, () => new ReplicaDatabase())
const DifferentTagProvider = Layer.merge(NeedsPrimaryDatabaseLive, ReplicaDatabaseLive)

expectTypeOf<LayerRawRequired<typeof DifferentTagProvider>>().toEqualTypeOf<PrimaryDatabase>()
expectTypeOf<LayerMissing<typeof DifferentTagProvider>>().toEqualTypeOf<PrimaryDatabase>()

// SAFETY: Compile-time-only Runtime receiver for different-tag validation.
const replicaRuntime = {} as Runtime<ReplicaDatabase>

// @ts-expect-error An identical contract with a different Service tag is not sufficient.
void replicaRuntime.run(() =>
  Effect.gen(async function* () {
    const database = yield* PrimaryDatabase

    return Result.ok(database)
  })
)

class DatabaseA extends Service<DatabaseA>()('Database') {
  query(): string {
    return 'a'
  }
}

class DatabaseB extends Service<DatabaseB>()('Database') {
  query(): string {
    return 'b'
  }
}

class NeedsDatabaseA extends Service<NeedsDatabaseA>()('NeedsDatabaseA') {
  use() {
    return Effect.gen(async function* () {
      const database = yield* DatabaseA

      return Result.ok(database.query())
    })
  }
}

const NeedsDatabaseALive = Layer.make(NeedsDatabaseA, () => new NeedsDatabaseA())
const DatabaseBLive = Layer.make(DatabaseB, () => new DatabaseB())
const SameTagCompatibleProvider = Layer.merge(NeedsDatabaseALive, DatabaseBLive)

expectTypeOf<LayerMissing<typeof SameTagCompatibleProvider>>().toBeNever()

const DatabaseAWithDependency = Layer.gen(
  DatabaseA,
  // oxlint-disable-next-line require-yield
  async function* () {
    return new DatabaseA()
  }
)
const DatabaseAOverridden = Layer.override(DatabaseAWithDependency, DatabaseBLive)

expectTypeOf<LayerProvided<typeof DatabaseAOverridden>>().toEqualTypeOf<DatabaseB>()
expectTypeOf<LayerMissing<typeof DatabaseAOverridden>>().toBeNever()

class IncompatibleDatabaseA extends Service<IncompatibleDatabaseA>()('IncompatibleDatabase') {
  query(): string {
    return 'query'
  }
}

class IncompatibleDatabaseB extends Service<IncompatibleDatabaseB>()('IncompatibleDatabase') {
  migrate(): Promise<void> {
    return Promise.resolve()
  }
}

class NeedsIncompatibleDatabase extends Service<NeedsIncompatibleDatabase>()(
  'NeedsIncompatibleDatabase'
) {
  use() {
    return Effect.gen(async function* () {
      const database = yield* IncompatibleDatabaseA

      return Result.ok(database.query())
    })
  }
}

const NeedsIncompatibleDatabaseLive = Layer.make(
  NeedsIncompatibleDatabase,
  () => new NeedsIncompatibleDatabase()
)
const IncompatibleDatabaseBLive = Layer.make(
  IncompatibleDatabaseB,
  () => new IncompatibleDatabaseB()
)
const SameTagIncompatibleProvider = Layer.merge(
  NeedsIncompatibleDatabaseLive,
  IncompatibleDatabaseBLive
)

expectTypeOf<
  LayerRawRequired<typeof SameTagIncompatibleProvider>
>().toEqualTypeOf<IncompatibleDatabaseA>()
expectTypeOf<
  LayerMissing<typeof SameTagIncompatibleProvider>
>().toEqualTypeOf<IncompatibleDatabaseA>()

const IncompatibleDatabaseOverridden = Layer.override(
  Layer.make(IncompatibleDatabaseA, () => new IncompatibleDatabaseA()),
  IncompatibleDatabaseBLive
)

expectTypeOf<CompleteLayer<typeof IncompatibleDatabaseOverridden>>().toMatchTypeOf<{
  readonly __betterEffectLayerOverrideCollisions: ServiceToken<
    'IncompatibleDatabase',
    IncompatibleDatabaseB
  >
}>()

// @ts-expect-error Incompatible same-tag overrides cannot form a complete Layer.
void Runtime.make(IncompatibleDatabaseOverridden, {} as never)

const structuralDatabase = Layer.succeed(DatabaseA, {
  query: () => 'fake'
})

expectTypeOf<LayerProvided<typeof structuralDatabase>>().toEqualTypeOf<DatabaseA>()

class RichDatabase extends Service<RichDatabase>()('DirectionalDatabase') {
  query(): string {
    return 'rich'
  }

  migrate(): void {}
}

class LeanDatabase extends Service<LeanDatabase>()('DirectionalDatabase') {
  query(): string {
    return 'lean'
  }
}

expectTypeOf<MissingServices<RichDatabase, RichDatabase | LeanDatabase>>().toBeNever()
expectTypeOf<
  MissingServices<DatabaseA | RichDatabase, DatabaseA | RichDatabase | LeanDatabase>
>().toBeNever()
expectTypeOf<
  MissingServices<RichDatabase | ReplicaDatabase, RichDatabase | LeanDatabase>
>().toEqualTypeOf<ReplicaDatabase>()

class NeedsRichDatabase extends Service<NeedsRichDatabase>()('NeedsRichDatabase') {
  use() {
    return Effect.gen(async function* () {
      const database = yield* RichDatabase

      return Result.ok(database)
    })
  }
}

const DirectionallyIncomplete = Layer.merge(Layer.make(NeedsRichDatabase), Layer.make(LeanDatabase))
expectTypeOf<LayerMissing<typeof DirectionallyIncomplete>>().toEqualTypeOf<RichDatabase>()

// SAFETY: Compile-time-only Runtime receiver for bidirectional same-tag contract validation.
const leanRuntime = {} as Runtime<LeanDatabase>
// @ts-expect-error A same-tag provider with fewer members does not satisfy RichDatabase.
void leanRuntime.run(() =>
  Effect.gen(async function* () {
    const database = yield* RichDatabase

    return Result.ok(database)
  })
)

const SameTagOverride = Layer.override(
  Layer.make(SameTagLeft, () => new SameTagLeft('left')),
  Layer.make(SameTagRight, () => new SameTagRight(1))
)
expectTypeOf<LayerProvided<typeof SameTagOverride>>().toEqualTypeOf<SameTagRight>()
expectTypeOf<LayerMissing<typeof SameTagOverride>>().toBeNever()
