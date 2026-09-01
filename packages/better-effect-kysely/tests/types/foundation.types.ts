import { expectTypeOf } from 'bun:test'
import {
  Effect,
  Layer,
  Runtime,
  ServiceRuntime,
  type RuntimeFor,
  type ServiceRequirement
} from 'better-effect'
import type { SelectQueryBuilder } from 'kysely'
import { Kysely, sql } from 'kysely'
import * as KyselyEffect from '../../src/index.ts'

interface UserTable {
  id: number
  email: string
}

interface PostTable {
  id: number
  authorId: number
  title: string
}

interface DatabaseSchema {
  users: UserTable
  posts: PostTable
}

const Database = KyselyEffect.KyselyEffect.service<DatabaseSchema>()('@app/Database')

type DatabaseInstance = KyselyEffect.KyselyServiceInstance<'@app/Database', DatabaseSchema>
type NamespacedInstance = KyselyEffect.KyselyEffect.ServiceInstance<'@app/Database', DatabaseSchema>
type NamespacedContract = KyselyEffect.KyselyEffect.Service<DatabaseSchema>
type NamespacedToken = KyselyEffect.KyselyEffect.ServiceToken<'@app/Database', DatabaseSchema>

declare const raw: Kysely<DatabaseSchema>
declare const analyticsRaw: Kysely<{ events: { id: string } }>
declare const invalidRaw: Kysely<{ other: { id: string } }>

expectTypeOf<DatabaseInstance>().toEqualTypeOf<NamespacedInstance>()
expectTypeOf<NamespacedContract>().toEqualTypeOf<Kysely<DatabaseSchema>>()
expectTypeOf<typeof Database>().toEqualTypeOf<NamespacedToken>()
expectTypeOf(Database.serviceTag).toEqualTypeOf<'@app/Database'>()
const database = Database.of(raw)
expectTypeOf(database).toEqualTypeOf<DatabaseInstance>()
expectTypeOf(Database.layer(() => raw)).toMatchTypeOf<Layer<DatabaseInstance, never>>()
expectTypeOf(Database.succeed(raw)).toMatchTypeOf<Layer<DatabaseInstance, never>>()
expectTypeOf<Layer.Provided<ReturnType<typeof Database.layer>>>().toEqualTypeOf<DatabaseInstance>()
expectTypeOf<Layer.Required<ReturnType<typeof Database.layer>>>().toBeNever()
expectTypeOf<
  Layer.Provided<ReturnType<typeof Database.succeed>>
>().toEqualTypeOf<DatabaseInstance>()
expectTypeOf<Layer.Required<ReturnType<typeof Database.succeed>>>().toBeNever()

const selected = database.selectFrom('users').select(['id', 'email'])
type SelectedRows = Awaited<ReturnType<typeof selected.execute>>
expectTypeOf<SelectedRows>().toEqualTypeOf<Array<{ id: number; email: string }>>()
expectTypeOf(selected).toMatchTypeOf<
  SelectQueryBuilder<DatabaseSchema, 'users', { id: number; email: string }>
>()

const joined = database
  .selectFrom('users')
  .innerJoin('posts', 'posts.authorId', 'users.id')
  .select(['users.email', 'posts.title'])
type JoinedRows = Awaited<ReturnType<typeof joined.execute>>
expectTypeOf<JoinedRows>().toEqualTypeOf<Array<{ email: string; title: string }>>()

const inserted = database
  .insertInto('users')
  .values({ id: 1, email: 'ada@example.test' })
  .returningAll()
type InsertedRows = Awaited<ReturnType<typeof inserted.execute>>
expectTypeOf<InsertedRows>().toEqualTypeOf<Array<UserTable>>()

const updated = database.updateTable('users').set({ email: 'new@example.test' }).returning('id')
type UpdatedRows = Awaited<ReturnType<typeof updated.execute>>
expectTypeOf<UpdatedRows>().toEqualTypeOf<Array<{ id: number }>>()

const deleted = database.deleteFrom('users').returning('email')
type DeletedRows = Awaited<ReturnType<typeof deleted.execute>>
expectTypeOf<DeletedRows>().toEqualTypeOf<Array<{ email: string }>>()

const aliasedJoin = database
  .selectFrom('users')
  .innerJoin('posts as post', 'post.authorId', 'users.id')
  .select(['users.email', 'post.title'])
type AliasedRows = Awaited<ReturnType<typeof aliasedJoin.execute>>
expectTypeOf<AliasedRows>().toEqualTypeOf<Array<{ email: string; title: string }>>()

const castQuery = selected.$castTo<{ id: string; email: string }>()
type CastRows = Awaited<ReturnType<typeof castQuery.execute>>
expectTypeOf<CastRows>().toEqualTypeOf<Array<{ id: string; email: string }>>()

const pickedDatabase = database.$pickTables<'users'>()
expectTypeOf(pickedDatabase).toEqualTypeOf<Kysely<{ users: UserTable }>>()

const transactionResult = database.transaction().execute(async (transaction) => {
  const row = await transaction.selectFrom('users').select('id').executeTakeFirst()
  return row?.id
})
expectTypeOf<Awaited<typeof transactionResult>>().toEqualTypeOf<number | undefined>()

const rawSql = sql<{ total: number }>`select 1 as total`
const rawSqlResult = rawSql.execute(database)
type RawSqlRows = Awaited<typeof rawSqlResult>['rows']
expectTypeOf<RawSqlRows>().toEqualTypeOf<Array<{ total: number }>>()

const schema = database.schema
const dynamic = database.dynamic
expectTypeOf(schema).toHaveProperty('createTable')
expectTypeOf(dynamic).toHaveProperty('ref')

const program = Effect.fn(async function* () {
  const database = yield* Database
  const query = database.selectFrom('users').selectAll()

  expectTypeOf(database).toEqualTypeOf<DatabaseInstance>()
  expectTypeOf(query).toMatchTypeOf<SelectQueryBuilder<DatabaseSchema, 'users', UserTable>>()

  return (await query.execute(), (await import('better-result')).Result.ok(query))
})

expectTypeOf<Effect.Requirements<typeof program>>().toEqualTypeOf<DatabaseInstance>()
declare const completeRuntime: Runtime<DatabaseInstance>
void completeRuntime.run(program)
void ServiceRuntime.resolve(Database)

const completeOwned = Layer.complete(Database.layer(() => raw))
expectTypeOf<Layer.Provided<typeof completeOwned>>().toEqualTypeOf<DatabaseInstance>()
expectTypeOf<Layer.Required<typeof completeOwned>>().toBeNever()
declare const namedRuntime: RuntimeFor<typeof completeOwned>
void namedRuntime.run(program)

// @ts-expect-error Kysely Service tokens must not be constructible by consumers.
new Database()

// @ts-expect-error a database for another schema is not accepted.
Database.succeed(invalidRaw)

// @ts-expect-error acquisition must produce the declared database schema.
Database.layer(() => invalidRaw)

// @ts-expect-error the Service iterator must carry the branded instance.
const wrongRequirement: ServiceRequirement<Kysely<{ other: { id: string } }>> = Database
void wrongRequirement

const Primary = KyselyEffect.KyselyEffect.service<DatabaseSchema>()('@app/Primary')
const Analytics = KyselyEffect.KyselyEffect.service<{ events: { id: string } }>()('@app/Analytics')
expectTypeOf(Primary.serviceTag).toEqualTypeOf<'@app/Primary'>()
expectTypeOf(Analytics.serviceTag).toEqualTypeOf<'@app/Analytics'>()

const SameSchema = KyselyEffect.KyselyEffect.service<DatabaseSchema>()('@app/SameSchema')
declare const sameSchemaInstance: KyselyEffect.KyselyServiceInstance<
  '@app/SameSchema',
  DatabaseSchema
>

// @ts-expect-error Service tags distinguish otherwise identical Kysely contracts.
const incompatibleToken: typeof Database = SameSchema
// @ts-expect-error Service tags distinguish otherwise identical Kysely instances.
const incompatibleInstance: DatabaseInstance = sameSchemaInstance
void incompatibleToken
void incompatibleInstance

const complete = Layer.complete(Layer.merge(Primary.succeed(raw), Analytics.succeed(analyticsRaw)))
expectTypeOf<Layer.Provided<typeof complete>>().toEqualTypeOf<
  | KyselyEffect.KyselyServiceInstance<'@app/Primary', DatabaseSchema>
  | KyselyEffect.KyselyServiceInstance<'@app/Analytics', { events: { id: string } }>
>()
