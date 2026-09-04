import { Layer } from 'better-effect'
import { MySqlJobStore, loadMySqlMigrations, quoteIdentifier } from 'better-effect-mq-mysql'

const migrations = await loadMySqlMigrations()
if (migrations.length !== 1 || !migrations[0]!.sql.includes('ENGINE=InnoDB')) {
  throw new Error('Expected the initial InnoDB migration')
}
if (quoteIdentifier('billing') !== '`billing`') throw new Error('Identifier quoting failed')

const pool = {
  getConnection: async () => ({
    query: async () => ({ rows: [], rowCount: 0 }),
    execute: async () => ({ rows: [], rowCount: 0 }),
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
    release: () => undefined
  })
}
const layer = MySqlJobStore.layer({ pool, validateSchema: false })
if (!(layer instanceof Layer)) throw new Error('Expected a better-effect Layer')
