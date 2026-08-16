import { expectTypeOf } from 'bun:test'

import type { EffectResult, ServiceRequirement } from '../../src/effect'
import { Layer, type LayerProvided, type LayerRawRequired, type LayerSpec } from '../../src/layer'
import type { LayerCollisions } from '../../src/layer/inference'
import { Service, type ServiceToken } from '../../src/service'

class Database extends Service<Database>()('Database') {
  query(): string {
    return 'query'
  }
}

class Logger extends Service<Logger>()('Logger') {
  log(): void {}
}

type DatabaseSpec = LayerSpec<typeof Database>
type LoggerSpec = LayerSpec<typeof Logger>
const DatabaseLive = Layer.make(Database)
declare const AppLive: Layer<DatabaseSpec | LoggerSpec>
const exact: Layer<DatabaseSpec> = DatabaseLive
// @ts-expect-error a Layer cannot invent a Logger provider
const invented: Layer<DatabaseSpec | LoggerSpec> = DatabaseLive
// @ts-expect-error a Layer cannot discard an exact provider specification
const narrowed: Layer<DatabaseSpec> = AppLive
// @ts-expect-error bare Layer is not an implicit metadata-erasure boundary
const bare: Layer = DatabaseLive
const erasedByAlias: Layer.Any = DatabaseLive
const erasedOrdinaryLayer: Layer<any, any> = DatabaseLive
const EmptyLive = Layer.merge()
const erasedEmptyLayer: Layer.Any = EmptyLive
// @ts-expect-error Layer<any, any> is not universal for never Specs
const incorrectlyErasedEmpty: Layer<any, any> = EmptyLive
expectTypeOf<LayerProvided<typeof EmptyLive>>().toEqualTypeOf<never>()
expectTypeOf<LayerRawRequired<typeof EmptyLive>>().toEqualTypeOf<never>()
expectTypeOf<LayerCollisions<typeof EmptyLive>>().toEqualTypeOf<never>()
type EmptyCollisionLayer = Layer<never, typeof Logger>
expectTypeOf<LayerProvided<EmptyCollisionLayer>>().toEqualTypeOf<never>()
expectTypeOf<LayerRawRequired<EmptyCollisionLayer>>().toEqualTypeOf<never>()
expectTypeOf<LayerCollisions<EmptyCollisionLayer>>().toEqualTypeOf<typeof Logger>()
declare const healthy: Layer<DatabaseSpec, never>
const conservativeCollision: Layer<DatabaseSpec, typeof Logger> = healthy
declare const collided: Layer<DatabaseSpec, typeof Logger>
// @ts-expect-error a known collision cannot be narrowed to never
const erasedCollision: Layer<DatabaseSpec, never> = collided
declare const specificSpec: LayerSpec<typeof Database, never>
const covariantSpec: LayerSpec<ServiceToken<string, Database>, typeof Logger> = specificSpec
declare const databaseRequirement: ServiceRequirement<typeof Database>
const covariantRequirement: ServiceRequirement<ServiceToken<string, Database>> = databaseRequirement
declare const databaseProgram: EffectResult<string, Error, typeof Database>
const conservativeProgram: EffectResult<string, Error, typeof Database | typeof Logger> =
  databaseProgram
declare const fullProgram: EffectResult<string, Error, typeof Database | typeof Logger>
// @ts-expect-error Effect requirements cannot be narrowed
const incompleteProgram: EffectResult<string, Error, typeof Database> = fullProgram

void exact
void invented
void narrowed
void bare
void erasedByAlias
void erasedOrdinaryLayer
void erasedEmptyLayer
void incorrectlyErasedEmpty
void conservativeCollision
void erasedCollision
void covariantSpec
void covariantRequirement
void conservativeProgram
void incompleteProgram
