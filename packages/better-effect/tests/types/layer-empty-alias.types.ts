import { expectTypeOf } from 'bun:test'
import { Result } from 'better-result'

import { Effect } from '../../src/effect'
import { Layer } from '../../src/layer'
import { Runtime } from '../../src/runtime'
import { Service } from '../../src/service'

class SqlUserRepository extends Service<SqlUserRepository>()('SqlUserRepository') {
  findById(id: string): string {
    return `sql:${id}`
  }
}

class UserRepository extends Service<UserRepository>()('UserRepository') {
  declare findById: SqlUserRepository['findById']
}

class IncompatibleRepository extends Service<IncompatibleRepository>()('IncompatibleRepository') {
  deleteById(id: string): void {
    void id
  }
}

class Config extends Service<Config>()('AliasConfig') {}

class ConfiguredSource extends Service<ConfiguredSource>()('ConfiguredSource') {
  load() {
    return Effect.gen(async function* () {
      const config = yield* Config

      return Result.ok({ value: config })
    })
  }
}

class ConfiguredTarget extends Service<ConfiguredTarget>()('ConfiguredTarget') {
  declare load: ConfiguredSource['load']
}

const empty = Layer.empty
const sourceLive = Layer.make(SqlUserRepository)
const alias = Layer.alias({ from: SqlUserRepository, to: UserRepository })
const aliasContract: Layer<UserRepository, SqlUserRepository> = alias
const complete = Layer.merge(empty, sourceLive, alias)

declare const unionAliasTarget: typeof UserRepository | typeof IncompatibleRepository
declare const unionAliasSource: typeof SqlUserRepository | typeof UserRepository

// @ts-expect-error An alias target must identify exactly one runtime Service token.
Layer.alias({ from: SqlUserRepository, to: unionAliasTarget })

// @ts-expect-error An alias source must identify exactly one runtime Service token.
Layer.alias({ from: unionAliasSource, to: UserRepository })

declare const backend: never

expectTypeOf(empty).toEqualTypeOf<Layer<never, never>>()
expectTypeOf<Layer.Provided<typeof empty>>().toBeNever()
expectTypeOf<Layer.Required<typeof empty>>().toBeNever()
expectTypeOf<Layer.Provided<typeof alias>>().toEqualTypeOf<UserRepository>()
expectTypeOf<Layer.Required<typeof alias>>().toEqualTypeOf<SqlUserRepository>()
expectTypeOf<Layer.Provided<typeof complete>>().toEqualTypeOf<SqlUserRepository | UserRepository>()
expectTypeOf<Layer.Required<typeof complete>>().toBeNever()

const runtime = Runtime.make(empty, backend)
const result = runtime.then((value) => value.run(() => 42))
expectTypeOf(result).toEqualTypeOf<Promise<number>>()

const configuredAlias = Layer.alias({ from: ConfiguredSource, to: ConfiguredTarget })
expectTypeOf<Layer.Required<typeof configuredAlias>>().toEqualTypeOf<ConfiguredSource | Config>()

const requiredSourceLive = Layer.make(ConfiguredSource)
const requiredWithEmpty = Layer.merge(Layer.empty, requiredSourceLive)
expectTypeOf<Layer.Provided<typeof requiredWithEmpty>>().toEqualTypeOf<ConfiguredSource>()
expectTypeOf<Layer.Required<typeof requiredWithEmpty>>().toEqualTypeOf<Config>()

// @ts-expect-error The source implementation must satisfy the target Service.Contract.
Layer.alias({ from: IncompatibleRepository, to: UserRepository })

// @ts-expect-error An alias with an unavailable source cannot complete a Runtime.
void Runtime.make(alias, backend)

void aliasContract
void complete
void configuredAlias
