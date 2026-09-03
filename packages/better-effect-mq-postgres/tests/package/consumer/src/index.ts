import { Layer } from 'better-effect'
import {
  PostgresJobStore,
  loadPostgresMigrations,
  migrationSql,
  quoteIdentifier
} from 'better-effect-mq-postgres'

const migrations = await loadPostgresMigrations()
if (migrations.length !== 1) throw new Error('Expected the initial migration')
if (!migrationSql(migrations[0]!, 'public').includes('"public"')) {
  throw new Error('Migration schema placeholder was not rendered')
}
if (quoteIdentifier('billing') !== '"billing"') throw new Error('Identifier quoting failed')

const pool = {
  connect: async () => ({
    query: async () => ({ rows: [], rowCount: 0 }),
    release: () => undefined
  })
}
const layer = PostgresJobStore.layer({ pool, validateSchema: false })
if (!(layer instanceof Layer)) throw new Error('Expected a better-effect Layer')
