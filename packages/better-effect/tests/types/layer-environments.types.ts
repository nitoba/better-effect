import { expectTypeOf } from 'bun:test'
import { Result } from 'better-result'

import { Effect } from '../../src/effect'
import { Layer } from '../../src/layer'
import { createRuntimeHandle } from '../../src/layer/runtime'
import { Runtime } from '../../src/runtime'
import { Service } from '../../src/service'

class Database extends Service<Database>()('Database') {
  query(): string {
    return 'query'
  }
}

class Config extends Service<Config>()('Config') {
  value(): string {
    return 'config'
  }
}

class Logger extends Service<Logger>()('Logger') {
  log(): void {}
}

class UserRepository extends Service<UserRepository>()('UserRepository') {
  find(): string {
    return 'user'
  }
}

const DatabaseLive = Layer.make(Database)
const RepositoryLive = Layer.gen(UserRepository, async function* () {
  const database = yield* Database
  const config = yield* Config
  const logger = yield* Logger

  void database
  void config
  void logger

  return new UserRepository()
})

const SyncRepositoryLive = Layer.gen(UserRepository, function* () {
  const database = yield* Database
  const config = yield* Config

  void database
  void config

  return new UserRepository()
})

expectTypeOf<Layer.Provided<typeof DatabaseLive>>().toEqualTypeOf<Database>()
expectTypeOf<Layer.Required<typeof DatabaseLive>>().toBeNever()
expectTypeOf<Layer.Provided<typeof RepositoryLive>>().toEqualTypeOf<UserRepository>()
expectTypeOf<Layer.Required<typeof RepositoryLive>>().toEqualTypeOf<Database | Config | Logger>()
expectTypeOf<Layer.Provided<typeof SyncRepositoryLive>>().toEqualTypeOf<UserRepository>()
expectTypeOf<Layer.Required<typeof SyncRepositoryLive>>().toEqualTypeOf<Database | Config>()

const AppLive = Layer.merge(DatabaseLive, RepositoryLive)

expectTypeOf<Layer.Provided<typeof AppLive>>().toEqualTypeOf<Database | UserRepository>()
expectTypeOf<Layer.Required<typeof AppLive>>().toEqualTypeOf<Config | Logger>()

const EmptyLive = Layer.merge()
expectTypeOf<Layer.Provided<typeof EmptyLive>>().toBeNever()
expectTypeOf<Layer.Required<typeof EmptyLive>>().toBeNever()

const Succeeded = Layer.succeed(UserRepository, new UserRepository())
expectTypeOf<Layer.Provided<typeof Succeeded>>().toEqualTypeOf<UserRepository>()
expectTypeOf<Layer.Required<typeof Succeeded>>().toBeNever()

const ScopedRepository = Layer.scoped(
  UserRepository,
  () => new UserRepository(),
  (repository) => {
    expectTypeOf(repository).toEqualTypeOf<UserRepository>()
  }
)

expectTypeOf<Layer.Provided<typeof ScopedRepository>>().toEqualTypeOf<UserRepository>()
expectTypeOf<Layer.Required<typeof ScopedRepository>>().toBeNever()

const ScopedGeneratedRepository = Layer.scopedGen(
  UserRepository,
  async function* () {
    const database = yield* Database
    void database
    return new UserRepository()
  },
  (repository, outcome) => {
    expectTypeOf(repository).toEqualTypeOf<UserRepository>()
    expectTypeOf(outcome.status).toEqualTypeOf<'success' | 'failure'>()
  }
)

expectTypeOf<Layer.Provided<typeof ScopedGeneratedRepository>>().toEqualTypeOf<UserRepository>()
expectTypeOf<Layer.Required<typeof ScopedGeneratedRepository>>().toEqualTypeOf<Database>()

class SelfRequiring extends Service<SelfRequiring>()('SelfRequiring') {
  run() {
    return Effect.gen(async function* () {
      const self = yield* SelfRequiring

      return Result.ok(self)
    })
  }
}

const SelfLive = Layer.make(SelfRequiring)
expectTypeOf<Layer.Required<typeof SelfLive>>().toBeNever()

const Replaced = Layer.override(RepositoryLive, Succeeded)
expectTypeOf<Layer.Provided<typeof Replaced>>().toEqualTypeOf<UserRepository>()
expectTypeOf<Layer.Required<typeof Replaced>>().toBeNever()

class Mailer extends Service<Mailer>()('Mailer') {
  send(): void {}
}

class FactoryDependency extends Service<FactoryDependency>()('FactoryDependency') {
  create(): void {}
}

class ReplacementDependency extends Service<ReplacementDependency>()('ReplacementDependency') {
  replace(): void {}
}

const RepositoryFromDatabase = Layer.gen(UserRepository, async function* () {
  const database = yield* Database
  void database
  return new UserRepository()
})

const MailerFromConfig = Layer.gen(Mailer, async function* () {
  const config = yield* Config
  void config
  return new Mailer()
})

const Base = Layer.merge(RepositoryFromDatabase, MailerFromConfig)
const RepositoryFake = Layer.succeed(UserRepository, new UserRepository())
const PreciseOverride = Layer.override(Base, RepositoryFake)

expectTypeOf<Layer.Required<typeof PreciseOverride>>().toEqualTypeOf<Config>()

const ErasedMailer: Layer<Mailer, Config> = MailerFromConfig
const Mixed = Layer.merge(RepositoryFromDatabase, ErasedMailer)
const MixedRepositoryOverride = Layer.override(Mixed, RepositoryFake)
const MixedMailerOverride = Layer.override(Mixed, Layer.succeed(Mailer, new Mailer()))

expectTypeOf<Layer.Required<typeof MixedRepositoryOverride>>().toEqualTypeOf<Config>()
expectTypeOf<Layer.Required<typeof MixedMailerOverride>>().toEqualTypeOf<Database | Config>()

declare const StickyConfig: Layer<never, Config>
const ConcreteConfig = Layer.merge(StickyConfig, Layer.make(Config))
expectTypeOf<Layer.Provided<typeof ConcreteConfig>>().toEqualTypeOf<Config>()
expectTypeOf<Layer.Required<typeof ConcreteConfig>>().toBeNever()

class AdversarialRichDatabase extends Service<AdversarialRichDatabase>()('AdversarialDatabase') {
  query(): string {
    return 'query'
  }

  migrate(): void {}
}

class AdversarialLeanDatabase extends Service<AdversarialLeanDatabase>()('AdversarialDatabase') {
  query(): string {
    return 'query'
  }
}

const richReplacement = Layer.make(AdversarialRichDatabase)

declare const ambiguousBase: Layer<AdversarialRichDatabase | AdversarialLeanDatabase, never>
// @ts-expect-error one compatible pair cannot hide the incompatible Lean pair
Layer.override(ambiguousBase, richReplacement)

class CompatibleOriginal extends Service<CompatibleOriginal>()('CompatibleErased') {
  static readonly original = true

  constructor(_value: string) {
    super()
  }

  read(): string {
    return 'original'
  }
}

class CompatibleReplacement extends Service<CompatibleReplacement>()('CompatibleErased') {
  static readonly replacement = true

  constructor(_value: number) {
    super()
  }

  read(): string {
    return 'replacement'
  }
}

class UnrelatedService extends Service<UnrelatedService>()('UnrelatedService') {
  use(): void {}
}

declare const erasedCompatibleBase: Layer<CompatibleOriginal | UnrelatedService, FactoryDependency>
const compatibleReplacement = Layer.make(CompatibleReplacement, () => new CompatibleReplacement(1))
const compatibleAfterErasure = Layer.override(erasedCompatibleBase, compatibleReplacement)

expectTypeOf<Layer.Provided<typeof compatibleAfterErasure>>().toEqualTypeOf<
  CompatibleReplacement | UnrelatedService
>()
expectTypeOf<Layer.Required<typeof compatibleAfterErasure>>().toEqualTypeOf<FactoryDependency>()

const RequiresReplacement = Layer.gen(UserRepository, async function* () {
  const dependency = yield* ReplacementDependency
  void dependency
  return new UserRepository()
})
const OrderedForward = Layer.override(RepositoryFromDatabase, RepositoryFake, RequiresReplacement)
const OrderedReverse = Layer.override(RepositoryFromDatabase, RequiresReplacement, RepositoryFake)

expectTypeOf<Layer.Required<typeof OrderedForward>>().toEqualTypeOf<ReplacementDependency>()
expectTypeOf<Layer.Required<typeof OrderedReverse>>().toBeNever()

class StatefulRich extends Service<StatefulRich>()('StatefulDatabase') {
  query(): string {
    return 'query'
  }

  migrate(): void {}
}

class StatefulLean extends Service<StatefulLean>()('StatefulDatabase') {
  query(): string {
    return 'query'
  }
}

// @ts-expect-error the second override is checked against the state introduced by the first
Layer.override(Layer.make(Database), Layer.make(StatefulRich), Layer.make(StatefulLean))

class StructuralLeft extends Service<StructuralLeft>()('StructuralLeft') {
  read(): string {
    return 'same'
  }
}

class StructuralRight extends Service<StructuralRight>()('StructuralRight') {
  read(): string {
    return 'same'
  }
}

const StructuralOverride = Layer.override(Layer.make(StructuralLeft), Layer.make(StructuralRight))
expectTypeOf<Layer.Provided<typeof StructuralOverride>>().toEqualTypeOf<
  StructuralLeft | StructuralRight
>()

class RichDatabase extends Service<RichDatabase>()('OverrideDatabase') {
  query(): string {
    return 'query'
  }

  migrate(): void {}
}

class LeanDatabase extends Service<LeanDatabase>()('OverrideDatabase') {
  query(): string {
    return 'query'
  }
}

const RichLive = Layer.make(RichDatabase)
const LeanLive = Layer.make(LeanDatabase)

// @ts-expect-error incompatible same-tag contracts must fail at Layer.override
Layer.override(RichLive, LeanLive)

const checked = RepositoryLive satisfies Layer<UserRepository, Database | Config | Logger>

// @ts-expect-error a Layer cannot invent Database as a provided Service
const invented: Layer<UserRepository | Database, Database | Config | Logger> = RepositoryLive

// @ts-expect-error required Services cannot be narrowed
const narrowedRequirement: Layer<UserRepository, Database> = RepositoryLive

declare const backend: never
declare const concreteUnion: Layer<Database, never> | Layer<Logger, never>

// @ts-expect-error a runtime branch does not guarantee both Services
Layer.merge(concreteUnion)
// @ts-expect-error Runtime cannot flatten a concrete Layer union
void Runtime.make(concreteUnion, backend)
// @ts-expect-error one-shot Runtime cannot flatten a concrete Layer union
void Runtime.run(concreteUnion, backend, () => 1)
// @ts-expect-error createRuntimeHandle rejects the same union
void createRuntimeHandle(concreteUnion, backend)
// @ts-expect-error override base must not flatten a concrete Layer union
Layer.override(concreteUnion, DatabaseLive)
// @ts-expect-error override replacement must not flatten a concrete Layer union
Layer.override(DatabaseLive, concreteUnion)

declare const crossConcreteUnion: Layer<Database, never> | Layer<never, any>
// @ts-expect-error a concrete union containing the erased-empty arm is not Layer.Any
Layer.merge(crossConcreteUnion)

declare const unchecked: Layer<any, any>
declare const erasedEmpty: Layer<never, any>
declare const partialRequired: Layer<Database, any>
declare const partialProvided: Layer<any, never>
declare const crossPartial: Layer<any, never> | Layer<never, any>
declare const bare: Layer

declare const erasedAlias: Layer.Any
void Runtime.make(unchecked, backend)
void Runtime.make(erasedEmpty, backend)
void Runtime.make(erasedAlias, backend)
void createRuntimeHandle(unchecked, backend)
void createRuntimeHandle(erasedEmpty, backend)
void createRuntimeHandle(erasedAlias, backend)
const completeAlias: Layer.Complete<typeof erasedAlias> = erasedAlias
const completeEmpty: Layer.Complete<typeof erasedEmpty> = erasedEmpty

// @ts-expect-error partial any is not an exact sentinel
void Runtime.make(partialRequired, backend)
// @ts-expect-error partial any is not an exact sentinel
void Runtime.make(partialProvided, backend)
// @ts-expect-error partial any is not an exact sentinel
Layer.override(DatabaseLive, partialRequired)
// @ts-expect-error partial any is not an exact sentinel
Layer.override(partialRequired, DatabaseLive)
// @ts-expect-error cross-partial union is not Layer.Any
void Runtime.make(crossPartial, backend)
// @ts-expect-error bare Layer remains incomplete
void Runtime.make(bare, backend)

// @ts-expect-error partial any is not complete
const invalidPartialComplete: Layer.Complete<typeof partialRequired> = partialRequired
declare const widenedEnvironment: Layer<Service.Any, Service.Any>
// @ts-expect-error widened Service.Any remains incomplete
const incompleteWidened: Layer.Complete<typeof widenedEnvironment> = widenedEnvironment
declare const bareEnvironment: Layer<Database>
// @ts-expect-error one-argument Layer remains incomplete
const incompleteBare: Layer.Complete<typeof bareEnvironment> = bareEnvironment
declare const widenedServiceLayer: Layer<Service.Any, Service.Any>
const mergedBare = Layer.merge(bare)
const mergedWidenedService = Layer.merge(widenedServiceLayer)
// @ts-expect-error bare Layer remains incomplete after merge
void Runtime.make(mergedBare, backend)
// @ts-expect-error widened Service.Any remains incomplete after merge
void Runtime.make(mergedWidenedService, backend)

const mergedUnchecked = Layer.merge(unchecked)
const mergedErasedEmpty = Layer.merge(erasedEmpty)
const mergedAlias = Layer.merge(erasedAlias)
expectTypeOf(mergedUnchecked).toMatchTypeOf<Layer<any, any>>()
expectTypeOf(mergedErasedEmpty).toMatchTypeOf<Layer<any, any>>()
expectTypeOf(mergedAlias).toMatchTypeOf<Layer<any, any>>()

const overriddenUnchecked = Layer.override(unchecked, DatabaseLive)
const overriddenErasedEmpty = Layer.override(erasedEmpty, DatabaseLive)
expectTypeOf(overriddenUnchecked).toMatchTypeOf<Layer<any, any>>()
expectTypeOf(overriddenErasedEmpty).toMatchTypeOf<Layer<any, any>>()

const unchanged = Layer.override(DatabaseLive)
expectTypeOf<Layer.Provided<typeof unchanged>>().toEqualTypeOf<Database>()
expectTypeOf<Layer.Required<typeof unchanged>>().toBeNever()

declare const widenedProvided: Layer<Service.Any, never>
// @ts-expect-error widened Service.Any cannot prove base compatibility
Layer.override(widenedProvided, DatabaseLive)
// @ts-expect-error widened Service.Any cannot prove replacement compatibility
Layer.override(DatabaseLive, widenedProvided)

void checked
void invented
void narrowedRequirement
void completeAlias
void completeEmpty
void invalidPartialComplete
void incompleteWidened
void incompleteBare
