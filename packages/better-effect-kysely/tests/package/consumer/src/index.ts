import { Layer, Runtime, ServiceRuntime } from 'better-effect'
import { Kysely } from 'kysely'
import { KyselyEffect } from 'better-effect-kysely'
import type { KyselyServiceInstance, KyselyServiceToken } from 'better-effect-kysely'

interface DatabaseSchema {
  users: {
    id: number
    email: string
  }
}

const Database = KyselyEffect.service<DatabaseSchema>()('@external/Database')
declare const database: Kysely<DatabaseSchema>

type ExpectedInstance = KyselyServiceInstance<'@external/Database', DatabaseSchema>
expectToken(Database)
expectInstance(Database.of(database))
expectLayer(Database.layer(() => database))
expectLayer(Database.succeed(database))
void KyselyEffect.service

function expectToken(token: KyselyServiceToken<'@external/Database', DatabaseSchema>): void {
  void token
}

function expectInstance(instance: ExpectedInstance): void {
  void instance
}

function expectLayer(layer: Layer<ExpectedInstance, never>): void {
  void layer
}

const program = async () => ServiceRuntime.resolve(Database)
void Runtime.make(Database.succeed(database)).then((runtime) => runtime.run(program))
