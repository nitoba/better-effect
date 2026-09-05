import { expectTypeOf } from 'bun:test'

import { Result } from 'better-result'

import { Effect } from '../../src/effect'
import { Layer } from '../../src/layer'
import type { MissingDependencies } from '../../src/internal/missing-dependencies'
import { Runtime } from '../../src/runtime'
import type { ScopeOutcome } from '../../src/scope'
import { Service } from '../../src/service'

class Config extends Service<Config>()('LifecycleConfig') {
  constructor(readonly intervalMs: number) {
    super()
  }
}

class Database extends Service<Database>()('LifecycleDatabase') {
  query(): string {
    return 'ok'
  }
}

const direct = Layer.scopedDiscard(
  () => ({ stop: () => {} }),
  (_resource, outcome) => {
    expectTypeOf(outcome).toEqualTypeOf<ScopeOutcome>()
  }
)

expectTypeOf<Layer.Provided<typeof direct>>().toBeNever()
expectTypeOf<Layer.Required<typeof direct>>().toBeNever()

const contextual = Layer.scopedDiscard(
  async function* () {
    const config = yield* Config
    const database = yield* Database

    return { config, database }
  },
  (resource, outcome) => {
    expectTypeOf(resource).toEqualTypeOf<{ config: Config; database: Database }>()
    expectTypeOf(outcome).toEqualTypeOf<ScopeOutcome>()
  }
)

expectTypeOf<Layer.Provided<typeof contextual>>().toBeNever()
expectTypeOf<Layer.Required<typeof contextual>>().toEqualTypeOf<Config | Database>()

const contextualAlias = Layer.scopedDiscardGen(
  async function* () {
    const config = yield* Config

    return config
  },
  (_resource, _outcome) => {}
)

expectTypeOf<Layer.Provided<typeof contextualAlias>>().toBeNever()
expectTypeOf<Layer.Required<typeof contextualAlias>>().toEqualTypeOf<Config>()

const ConfigLive = Layer.succeed(Config, new Config(250))
const DatabaseLive = Layer.succeed(Database, new Database())
const complete = Layer.merge(ConfigLive, DatabaseLive, contextual)

expectTypeOf<Layer.Provided<typeof complete>>().toEqualTypeOf<Config | Database>()
expectTypeOf<Layer.Required<typeof complete>>().toBeNever()
expectTypeOf<Layer.Complete<typeof complete>>().toEqualTypeOf<typeof complete>()
expectTypeOf<Layer.Required<typeof contextual>>().toEqualTypeOf<Config | Database>()

const incomplete = Layer.merge(contextual)

expectTypeOf<Layer.Complete<typeof incomplete>>().toMatchTypeOf<
  typeof incomplete & MissingDependencies<Config | Database>
>()

// @ts-expect-error Lifecycle requirements must be completed before use.
Layer.complete(incomplete)

void Runtime.make(complete)
// @ts-expect-error Runtime.make enforces lifecycle requirements as Layer requirements.
void Runtime.make(incomplete)

const first = Layer.scopedDiscard(
  () => 'first',
  () => {}
)
const second = Layer.scopedDiscard(
  () => 'second',
  () => {}
)
const both = Layer.merge(first, second)

expectTypeOf<Layer.Provided<typeof both>>().toBeNever()
expectTypeOf<Layer.Required<typeof both>>().toBeNever()

const noFailure = Effect.fn(async function* () {
  const config = yield* Config

  void config
  return Result.ok(undefined)
})
const effectDiscard = Layer.effectDiscard(noFailure)

expectTypeOf<Layer.Provided<typeof effectDiscard>>().toBeNever()
expectTypeOf<Layer.Required<typeof effectDiscard>>().toEqualTypeOf<Config>()

// oxlint-disable-next-line require-yield -- Effect.fn accepts a generator-shaped async body.
const typedFailure = Effect.fn(async function* () {
  return Result.err('typed failure' as const)
})

// @ts-expect-error effectDiscard must not erase a typed failure channel.
Layer.effectDiscard(typedFailure)
