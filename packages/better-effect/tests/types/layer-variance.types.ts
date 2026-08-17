import { expectTypeOf } from 'bun:test'

import type { Effect, ServiceRequirement } from '../../src/effect'
import { Layer } from '../../src/layer'
import { Service, type ServiceIdentity } from '../../src/service'

class Database extends Service<Database>()('Database') {
  query(): string {
    return 'query'
  }
}

class Logger extends Service<Logger>()('Logger') {
  log(): void {}
}

const DatabaseLive = Layer.make(Database)
const exact: Layer<Database, never> = DatabaseLive

// @ts-expect-error a Layer cannot invent Logger
const invented: Layer<Database | Logger, never> = DatabaseLive

declare const needsDatabaseAndLogger: Layer<Database, Database | Logger>
// @ts-expect-error Required cannot be narrowed
const needsOnlyDatabase: Layer<Database, Database> = needsDatabaseAndLogger

const conservativeRequirement: Layer<Database, Database | Logger> = exact

// @ts-expect-error bare Layer is not an implicit metadata-erasure boundary
const bare: Layer = DatabaseLive

const erasedByAlias: Layer.Any = DatabaseLive
const erasedOrdinaryLayer: Layer<any, any> = DatabaseLive

const EmptyLive = Layer.merge()
const erasedEmptyLayer: Layer.Any = EmptyLive

// @ts-expect-error Layer<any, any> is not universal for an inferred empty Layer
const incorrectlyErasedEmpty: Layer<any, any> = EmptyLive

expectTypeOf<Layer.Provided<typeof EmptyLive>>().toBeNever()
expectTypeOf<Layer.Required<typeof EmptyLive>>().toBeNever()

declare const stickyEmpty: Layer<never, Logger>
expectTypeOf<Layer.Provided<typeof stickyEmpty>>().toBeNever()
expectTypeOf<Layer.Required<typeof stickyEmpty>>().toEqualTypeOf<Logger>()

const conservativeRequired: Layer<Database, Logger> = exact
const widenedRequired: Layer<Database, Database | Logger> = conservativeRequired
// @ts-expect-error Required cannot be narrowed
const narrowedRequired: Layer<Database, never> = conservativeRequired

declare const databaseRequirement: ServiceRequirement<Database>
const covariantRequirement: ServiceRequirement<ServiceIdentity<string>> = databaseRequirement

declare const databaseProgram: Effect<string, Error, Database>
const conservativeProgram: Effect<string, Error, Database | Logger> = databaseProgram
declare const fullProgram: Effect<string, Error, Database | Logger>
// @ts-expect-error Effect requirements cannot be narrowed
const incompleteProgram: Effect<string, Error, Database> = fullProgram

void exact
void invented
void needsOnlyDatabase
void conservativeRequirement
void bare
void erasedByAlias
void erasedOrdinaryLayer
void erasedEmptyLayer
void incorrectlyErasedEmpty
void stickyEmpty
void conservativeRequired
void widenedRequired
void narrowedRequired
void covariantRequirement
void conservativeProgram
void incompleteProgram
