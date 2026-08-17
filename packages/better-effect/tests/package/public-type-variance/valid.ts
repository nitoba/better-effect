import {
  Layer,
  Service,
  type AnyService,
  type Effect,
  type ServiceClass,
  type ServiceContract,
  type ServiceRequirement,
  type ServiceToken
} from 'better-effect'

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false

type Expect<Value extends true> = Value

export class AnimalService extends Service<AnimalService>()('Animal') {
  readonly name: string = 'animal'
}

export class DogService extends Service<DogService>()('Animal') {
  readonly name: string = 'dog'

  bark(): void {}
}

const dogClass: ServiceClass<'Animal', DogService> = DogService

// @ts-expect-error built ServiceClass declarations preserve instance invariance
const widenedClass: ServiceClass<'Animal', AnimalService> = dogClass

const dogToken: ServiceToken<'Animal', DogService> = DogService

// @ts-expect-error built ServiceToken declarations preserve instance invariance
const widenedToken: ServiceToken<'Animal', AnimalService> = dogToken

const widenedTag: ServiceClass<string, DogService> = dogClass

// @ts-expect-error a widened built Service tag cannot be narrowed again
const narrowedTag: ServiceClass<'Animal', DogService> = widenedTag

class ManualService {
  static readonly serviceTag = 'Manual'

  static of(this: void, implementation: ManualService): ManualService {
    return implementation
  }

  run(): string {
    return 'manual'
  }
}

// @ts-expect-error built declarations preserve the hidden Service marker
const manualToken: ServiceToken<'Manual', ManualService> = ManualService

// @ts-expect-error built declarations preserve the hidden Service marker
const manualClass: ServiceClass<'Manual', ManualService> = ManualService

export class Database extends Service<Database>()('Database') {
  query(): string {
    return 'query'
  }
}

export class Logger extends Service<Logger>()('Logger') {
  log(): void {}
}

type DatabaseSpec = {
  readonly provided: Database
  readonly required: never
  readonly token: typeof Database
}

type LoggerSpec = {
  readonly provided: Logger
  readonly required: never
  readonly token: typeof Logger
}

const DatabaseLive = Layer.make(Database)
declare const AppLive: Layer<DatabaseSpec | LoggerSpec>

// @ts-expect-error built Layer declarations cannot invent providers
const invented: Layer<DatabaseSpec | LoggerSpec> = DatabaseLive

// @ts-expect-error built Layer declarations cannot discard providers
const narrowed: Layer<DatabaseSpec> = AppLive

// @ts-expect-error bare Layer is not an implicit erasure boundary
const bare: Layer = DatabaseLive

const erasedByAlias: Layer.Any = DatabaseLive
const erasedOrdinaryLayer: Layer<any, any> = DatabaseLive

const EmptyLive = Layer.merge()
const erasedEmptyLayer: Layer.Any = EmptyLive

// @ts-expect-error Layer<any, any> does not erase never Specs
const incorrectlyErasedEmpty: Layer<any, any> = EmptyLive

export type EmptyProvided = Expect<Equal<Layer.Provided<typeof EmptyLive>, never>>
export type EmptyRequired = Expect<Equal<Layer.Required<typeof EmptyLive>, never>>

declare const databaseRequirement: ServiceRequirement<Database>
const covariantRequirement: ServiceRequirement<AnyService> = databaseRequirement

declare const databaseProgram: Effect<string, Error, Database>
const conservativeProgram: Effect<string, Error, Database | Logger> = databaseProgram
declare const fullProgram: Effect<string, Error, Database | Logger>

// @ts-expect-error built Effect requirements cannot be narrowed
const incompleteProgram: Effect<string, Error, Database> = fullProgram

const structuralDatabase: ServiceContract<Database> = {
  query: () => 'structural'
}

// @ts-expect-error arbitrary structural implementations do not carry Service identity
const brandedDatabase: Database = structuralDatabase

void widenedClass
void widenedToken
void widenedTag
void narrowedTag
void manualToken
void manualClass
void invented
void narrowed
void bare
void erasedByAlias
void erasedOrdinaryLayer
void erasedEmptyLayer
void incorrectlyErasedEmpty
void covariantRequirement
void conservativeProgram
void incompleteProgram
void structuralDatabase
void brandedDatabase
