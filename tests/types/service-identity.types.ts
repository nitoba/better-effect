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
import { Runtime } from '../../src/runtime'
import { Service, type ServiceToken } from '../../src/service'

class EmptyPrimary extends Service<EmptyPrimary>()('EmptyPrimary') {}

class EmptyReplica extends Service<EmptyReplica>()('EmptyReplica') {}

expectTypeOf<InstanceType<typeof EmptyPrimary>>().toEqualTypeOf<InstanceType<typeof EmptyReplica>>()
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

expectTypeOf<InstanceType<typeof PrimaryDatabase>>().toEqualTypeOf<
  InstanceType<typeof ReplicaDatabase>
>()

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

expectTypeOf<LayerRawRequired<typeof DifferentTagProvider>>().toEqualTypeOf<
  ServiceToken<'PrimaryDatabase', PrimaryDatabase>
>()
expectTypeOf<LayerMissing<typeof DifferentTagProvider>>().toEqualTypeOf<
  ServiceToken<'PrimaryDatabase', PrimaryDatabase>
>()

const replicaRuntime = {} as Runtime<typeof ReplicaDatabase>

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

expectTypeOf<LayerMissing<typeof SameTagCompatibleProvider>>().toEqualTypeOf<never>()

const DatabaseAWithDependency = Layer.gen(
  DatabaseA,
  // oxlint-disable-next-line require-yield
  async function* () {
    return new DatabaseA()
  }
)
const DatabaseAOverridden = Layer.override(DatabaseAWithDependency, DatabaseBLive)

expectTypeOf<LayerProvided<typeof DatabaseAOverridden>>().toEqualTypeOf<typeof DatabaseB>()
expectTypeOf<LayerMissing<typeof DatabaseAOverridden>>().toEqualTypeOf<never>()

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

expectTypeOf<LayerRawRequired<typeof SameTagIncompatibleProvider>>().toEqualTypeOf<
  ServiceToken<'IncompatibleDatabase', IncompatibleDatabaseA>
>()
expectTypeOf<LayerMissing<typeof SameTagIncompatibleProvider>>().toEqualTypeOf<
  ServiceToken<'IncompatibleDatabase', IncompatibleDatabaseA>
>()

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

expectTypeOf<LayerProvided<typeof structuralDatabase>>().toEqualTypeOf<typeof DatabaseA>()
