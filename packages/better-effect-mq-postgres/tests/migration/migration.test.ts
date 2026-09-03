// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fake driver rows are controlled by this test.

import { describe, expect, test } from 'bun:test'
import { Layer, Runtime, ServiceRuntime } from 'better-effect'
import { JobStore } from 'better-effect-mq'
import {
  PostgresClient,
  PostgresConfigurationError,
  PostgresMigrationError,
  PostgresMigrator,
  PostgresSchemaValidationError,
  PostgresJobStore,
  POSTGRES_INDEXES,
  POSTGRES_TABLES,
  loadPostgresMigrations,
  migrationSql,
  normalizePostgresJobStoreConfig,
  quoteIdentifier
} from '../../src/index'
import type { Pool, PoolClient, QueryResult } from '../../src/index'

const result = <T>(rows: readonly T[] = []): QueryResult<T> => ({
  rows,
  rowCount: rows.length
})

type FakeOptions = {
  readonly version?: { readonly version: number; readonly checksum: string }
  readonly tables?: readonly string[]
  readonly validSchema?: boolean
  readonly invalidIndex?: string
  readonly invalidConstraint?: string
  readonly invalidConstraintColumns?: readonly number[]
  readonly invalidReferencedConstraintColumns?: readonly number[]
}

const validColumnNames = {
  [POSTGRES_TABLES.jobs]: [
    'namespace',
    'id',
    'queue',
    'name',
    'version',
    'state',
    'payload',
    'metadata',
    'priority',
    'run_at_ms',
    'sequence',
    'attempts_max',
    'attempts_made',
    'delivery_count',
    'stalled_count',
    'attempt_sequence',
    'backoff',
    'timeout_ms',
    'idempotency_key',
    'dedupe_key',
    'created_at_ms',
    'updated_at_ms',
    'processed_at_ms',
    'finished_at_ms',
    'lease_owner',
    'lease_token',
    'lease_expires_at_ms',
    'cancel_requested',
    'cancellation_requested_at_ms',
    'result',
    'failure',
    'last_settlement_token',
    'last_settlement_outcome',
    'last_settlement_attempt_sequence'
  ],
  [POSTGRES_TABLES.attempts]: [
    'namespace',
    'job_id',
    'ledger_sequence',
    'attempt_sequence',
    'attempt',
    'delivery',
    'started_at_ms',
    'finished_at_ms',
    'outcome',
    'result',
    'failure',
    'worker_id',
    'retry_at_ms',
    'retry_delay_ms'
  ],
  [POSTGRES_TABLES.queues]: ['namespace', 'queue', 'paused', 'wake_version', 'updated_at_ms'],
  [POSTGRES_TABLES.schemaVersions]: ['component', 'version', 'applied_at_ms', 'checksum']
} as const

const validConstraintDefinitions = {
  better_effect_mq_jobs_nonempty: `CHECK (((namespace <> '') AND (id <> '') AND (queue <> '') AND (name <> '')))`,
  better_effect_mq_jobs_state: `CHECK ((state = ANY (ARRAY['waiting', 'delayed', 'active', 'completed', 'failed', 'cancelled'])))`,
  better_effect_mq_jobs_version: `CHECK ((version > 0))`,
  better_effect_mq_jobs_counters: `CHECK (((attempts_max >= 1) AND (attempts_made >= 0) AND (attempts_made <= attempts_max) AND (attempts_made <= delivery_count) AND (delivery_count >= 0) AND (stalled_count >= 0) AND (attempt_sequence >= attempts_made) AND ((state <> ALL (ARRAY['waiting', 'delayed', 'active'])) OR (attempts_made < attempts_max)) AND ((state <> 'active') OR (attempts_made < delivery_count))))`,
  better_effect_mq_jobs_epoch_ms: `CHECK ((((run_at_ms >= 0) AND (run_at_ms <= '9007199254740991')) AND ((created_at_ms >= 0) AND (created_at_ms <= '9007199254740991')) AND ((updated_at_ms >= 0) AND (updated_at_ms <= '9007199254740991')) AND ((timeout_ms IS NULL) OR ((timeout_ms >= 1) AND (timeout_ms <= '9007199254740991'))) AND ((processed_at_ms IS NULL) OR ((processed_at_ms >= 0) AND (processed_at_ms <= '9007199254740991'))) AND ((finished_at_ms IS NULL) OR ((finished_at_ms >= 0) AND (finished_at_ms <= '9007199254740991'))) AND ((lease_expires_at_ms IS NULL) OR ((lease_expires_at_ms >= 0) AND (lease_expires_at_ms <= '9007199254740991'))) AND ((cancellation_requested_at_ms IS NULL) OR ((cancellation_requested_at_ms >= 0) AND (cancellation_requested_at_ms <= '9007199254740991')))))`,
  better_effect_mq_jobs_metadata_values: `CHECK (((jsonb_typeof(metadata) = 'object') AND (NOT jsonb_path_exists(metadata, '$.*?(@.type() != "string")'))))`,
  better_effect_mq_jobs_tokens: `CHECK ((((idempotency_key IS NULL) OR (idempotency_key <> '')) AND ((dedupe_key IS NULL) OR (dedupe_key <> '')) AND ((lease_owner IS NULL) OR (lease_owner <> '')) AND ((lease_token IS NULL) OR (lease_token <> '')) AND ((last_settlement_token IS NULL) OR (last_settlement_token <> ''))))`,
  better_effect_mq_jobs_active_lease: `CHECK ((((state = 'active') AND (lease_owner IS NOT NULL) AND (lease_owner <> '') AND (lease_token IS NOT NULL) AND (lease_token <> '') AND (lease_expires_at_ms IS NOT NULL)) OR ((state <> 'active') AND (lease_owner IS NULL) AND (lease_token IS NULL) AND (lease_expires_at_ms IS NULL))))`,
  better_effect_mq_jobs_cancel_requested: `CHECK (((cancel_requested = (cancellation_requested_at_ms IS NOT NULL)) AND ((state = 'active') OR (cancellation_requested_at_ms IS NULL))))`,
  better_effect_mq_jobs_terminal_time: `CHECK (((state <> ALL (ARRAY['completed', 'failed', 'cancelled'])) OR (finished_at_ms IS NOT NULL)))`,
  better_effect_mq_jobs_settlement_pair: `CHECK ((((last_settlement_token IS NULL) AND (last_settlement_outcome IS NULL) AND (last_settlement_attempt_sequence IS NULL)) OR ((last_settlement_token IS NOT NULL) AND (last_settlement_outcome IS NOT NULL) AND (last_settlement_attempt_sequence IS NOT NULL))))`,
  better_effect_mq_attempts_values: `CHECK (((namespace <> '') AND (job_id <> '') AND (attempt >= 1) AND (delivery >= 1)))`,
  better_effect_mq_attempts_tokens: `CHECK (((worker_id IS NULL) OR (worker_id <> '')))`,
  better_effect_mq_attempts_retry: `CHECK ((((outcome = 'retried') AND (retry_at_ms IS NOT NULL) AND (retry_delay_ms IS NOT NULL)) OR ((outcome <> 'retried') AND (retry_at_ms IS NULL) AND (retry_delay_ms IS NULL))))`,
  better_effect_mq_attempts_outcome: `CHECK ((outcome = ANY (ARRAY['completed', 'retried', 'failed', 'cancelled', 'stalled', 'released'])))`,
  better_effect_mq_attempts_times: `CHECK ((((started_at_ms IS NULL) OR ((started_at_ms >= 0) AND (started_at_ms <= '9007199254740991'))) AND ((finished_at_ms >= 0) AND (finished_at_ms <= '9007199254740991')) AND ((retry_at_ms IS NULL) OR ((retry_at_ms >= 0) AND (retry_at_ms <= '9007199254740991'))) AND ((retry_delay_ms IS NULL) OR ((retry_delay_ms >= 0) AND (retry_delay_ms <= '9007199254740991'))) AND ((attempt_sequence IS NULL) OR (attempt_sequence = attempt)) AND ((started_at_ms IS NULL) OR (started_at_ms <= finished_at_ms))))`,
  better_effect_mq_queues_values: `CHECK (((namespace <> '') AND (queue <> '') AND ((wake_version >= 0) AND (wake_version <= '9007199254740991')) AND ((updated_at_ms >= 0) AND (updated_at_ms <= '9007199254740991'))))`,
  better_effect_mq_schema_versions_values: `CHECK (((component <> '') AND (version >= 0) AND ((applied_at_ms >= 0) AND (applied_at_ms <= '9007199254740991')) AND (checksum <> '')))`
} as const

const validIndexDefinitions = {
  [POSTGRES_INDEXES[0]]:
    'CREATE INDEX better_effect_mq_jobs_claim_idx ON better_effect_mq_jobs (namespace, queue, state, priority DESC, run_at_ms ASC, sequence ASC, id COLLATE "C" ASC)',
  [POSTGRES_INDEXES[1]]:
    "CREATE INDEX better_effect_mq_jobs_active_lease_idx ON better_effect_mq_jobs (namespace, state, lease_expires_at_ms ASC) WHERE state = 'active'",
  [POSTGRES_INDEXES[2]]:
    'CREATE INDEX better_effect_mq_jobs_identity_idx ON better_effect_mq_jobs (namespace, queue, name, version, state)',
  [POSTGRES_INDEXES[3]]:
    'CREATE INDEX better_effect_mq_jobs_recent_idx ON better_effect_mq_jobs (namespace, created_at_ms DESC, sequence DESC, id COLLATE "C" DESC)',
  [POSTGRES_INDEXES[4]]:
    'CREATE INDEX better_effect_mq_jobs_run_at_idx ON better_effect_mq_jobs (namespace, queue, state, run_at_ms ASC, sequence ASC, id COLLATE "C" ASC)',
  [POSTGRES_INDEXES[5]]:
    "CREATE INDEX better_effect_mq_jobs_terminal_idx ON better_effect_mq_jobs (namespace, state, finished_at_ms DESC, sequence DESC, id COLLATE \"C\" DESC) WHERE state = ANY (ARRAY['completed', 'failed', 'cancelled'])",
  [POSTGRES_INDEXES[6]]:
    'CREATE INDEX better_effect_mq_jobs_metadata_idx ON better_effect_mq_jobs USING gin (metadata jsonb_path_ops)',
  [POSTGRES_INDEXES[7]]:
    'CREATE UNIQUE INDEX better_effect_mq_jobs_idempotency_idx ON better_effect_mq_jobs (namespace, queue, name, version, dedupe_key) WHERE dedupe_key IS NOT NULL'
} as const

const validConstraintRows = (schema: string) => [
  {
    conname: 'better_effect_mq_jobs_pkey',
    table_name: POSTGRES_TABLES.jobs,
    constraint_type: 'p',
    validated: true,
    definition: 'PRIMARY KEY (namespace, id)',
    conkey: [1, 2],
    confkey: null
  },
  ...Object.entries(validConstraintDefinitions).map(([conname, definition]) => ({
    conname,
    table_name: conname.startsWith('better_effect_mq_jobs_')
      ? POSTGRES_TABLES.jobs
      : conname.startsWith('better_effect_mq_attempts_')
        ? POSTGRES_TABLES.attempts
        : conname.startsWith('better_effect_mq_queues_')
          ? POSTGRES_TABLES.queues
          : POSTGRES_TABLES.schemaVersions,
    constraint_type: 'c',
    validated: true,
    definition
  })),
  {
    conname: 'better_effect_mq_attempts_pkey',
    table_name: POSTGRES_TABLES.attempts,
    constraint_type: 'p',
    validated: true,
    definition: 'PRIMARY KEY (namespace, job_id, ledger_sequence)',
    conkey: [1, 2, 3],
    confkey: null
  },
  {
    conname: 'better_effect_mq_attempts_job_fk',
    table_name: POSTGRES_TABLES.attempts,
    constraint_type: 'f',
    validated: true,
    definition: `FOREIGN KEY (namespace, job_id) REFERENCES ${schema}.${POSTGRES_TABLES.jobs}(namespace, id) ON DELETE CASCADE`,
    referenced_schema: schema,
    referenced_table: POSTGRES_TABLES.jobs,
    delete_action: 'c',
    conkey: [1, 2],
    confkey: [1, 2]
  },
  {
    conname: 'better_effect_mq_queues_pkey',
    table_name: POSTGRES_TABLES.queues,
    constraint_type: 'p',
    validated: true,
    definition: 'PRIMARY KEY (namespace, queue)',
    conkey: [1, 2],
    confkey: null
  },
  {
    conname: 'better_effect_mq_schema_versions_pkey',
    table_name: POSTGRES_TABLES.schemaVersions,
    constraint_type: 'p',
    validated: true,
    definition: 'PRIMARY KEY (component)',
    conkey: [1],
    confkey: null
  }
]

const fakePool = (options: FakeOptions = {}) => {
  const queries: Array<{ readonly sql: string; readonly values?: readonly unknown[] }> = []
  const client: PoolClient = {
    query: async <T>(sql: string, values?: readonly unknown[]): Promise<QueryResult<T>> => {
      queries.push(values === undefined ? { sql } : { sql, values })
      if (sql.includes('SELECT version, checksum')) {
        return result(options.version === undefined ? [] : [options.version]) as QueryResult<T>
      }
      if (sql.includes('information_schema.tables')) {
        const tables = options.validSchema ? Object.values(POSTGRES_TABLES) : (options.tables ?? [])
        return result(tables.map((table_name) => ({ table_name }))) as QueryResult<T>
      }
      if (options.validSchema && sql.includes('information_schema.columns')) {
        return result(
          Object.entries(validColumnNames).flatMap(([table_name, columnNames]) =>
            columnNames.map((column_name) => ({ table_name, column_name }))
          )
        ) as QueryResult<T>
      }
      if (options.validSchema && sql.includes('FROM pg_indexes')) {
        return result(
          POSTGRES_INDEXES.map((indexname) => ({
            indexname,
            tablename: POSTGRES_TABLES.jobs,
            indexdef: validIndexDefinitions[indexname],
            is_valid: indexname !== options.invalidIndex,
            is_ready: true,
            is_unique: indexname === POSTGRES_INDEXES[7],
            access_method: indexname === POSTGRES_INDEXES[6] ? 'gin' : 'btree'
          }))
        ) as QueryResult<T>
      }
      if (options.validSchema && sql.includes('FROM pg_attribute')) {
        return result(
          Object.entries(validColumnNames).flatMap(([table_name, columnNames]) =>
            columnNames.map((attname, index) => ({ table_name, attnum: index + 1, attname }))
          )
        ) as QueryResult<T>
      }
      if (options.validSchema && sql.includes('FROM pg_constraint')) {
        const schema = (values?.[0] ?? 'public') as string
        const rows = validConstraintRows(schema).map((row) =>
          row.conname === options.invalidConstraint
            ? {
                ...row,
                conkey:
                  options.invalidConstraintColumns ?? ('conkey' in row ? row.conkey : undefined),
                confkey:
                  options.invalidReferencedConstraintColumns ??
                  ('confkey' in row ? row.confkey : undefined)
              }
            : row
        )
        return result(rows) as QueryResult<T>
      }
      return result() as QueryResult<T>
    },
    release: () => undefined
  }
  const pool: Pool = { connect: async () => client }
  return { pool, queries }
}

const expectRejects = async (promise: Promise<unknown>, error: new (...args: any[]) => Error) => {
  // oxlint-disable-next-line typescript/await-thenable -- Bun's rejection matcher is thenable at runtime.
  await expect(promise).rejects.toBeInstanceOf(error)
}

describe('Postgres foundation', () => {
  test('validates and quotes schema identifiers, never namespaces', () => {
    expect(quoteIdentifier('tenant_1')).toBe('"tenant_1"')
    expect(() => quoteIdentifier('public"; DROP TABLE jobs;--')).toThrow(PostgresConfigurationError)
    expect(
      migrationSql(
        { version: 1, name: 'test', sql: 'SELECT $1, {{SCHEMA}}.jobs', checksum: 'x' },
        'tenant_1'
      )
    ).toBe('SELECT $1, "tenant_1".jobs')
  })

  test('loads the shipped migration with a stable checksum', async () => {
    const migrations = await loadPostgresMigrations()
    expect(migrations).toHaveLength(1)
    expect(migrations[0]?.version).toBe(1)
    expect(migrations[0]?.sql).toContain('better_effect_mq_jobs')
    expect(migrations[0]?.checksum).toMatch(/^[0-9a-f]{64}$/u)
  })

  test('caller-owned pools are not closed', async () => {
    let ended = false
    const pool: Pool = {
      connect: async () => ({ query: async () => result(), release: () => undefined }),
      end: async () => {
        ended = true
      }
    }
    const client = PostgresClient.fromPool({ pool, namespace: 'billing' })
    await client.dispose()
    expect(client.ownsPool).toBe(false)
    expect(ended).toBe(false)
  })

  test('connection-backed clients own and dispose their pool once', async () => {
    const client = await PostgresClient.fromConfig({
      connectionString: 'postgres://user:secret@127.0.0.1:1/database',
      validateSchema: false
    })
    expect(client.ownsPool).toBe(true)
    await Promise.all([client.dispose(), client.dispose()])
  })

  test('owned clients close their pool exactly once', async () => {
    let endCalls = 0
    const pool: Pool = {
      connect: async () => ({ query: async () => result(), release: () => undefined }),
      end: async () => {
        endCalls += 1
      }
    }
    const client = new PostgresClient(pool, {}, true)
    await Promise.all([client.dispose(), client.dispose(), client.close()])
    expect(endCalls).toBe(1)
  })

  test('owned Layer cleanup closes the client exactly once', async () => {
    let endCalls = 0
    const pool: Pool = {
      connect: async () => ({ query: async () => result(), release: () => undefined }),
      end: async () => {
        endCalls += 1
      }
    }
    const client = new PostgresClient(pool, {}, true)
    const runtime = await Runtime.make(Layer.scopedDisposable(PostgresClient, () => client))
    await runtime.run(() => ServiceRuntime.resolve(PostgresClient))
    await runtime.dispose()
    expect(endCalls).toBe(1)
  })

  test('borrowed Layer provides the client without taking pool ownership', async () => {
    let ended = false
    const pool: Pool = {
      connect: async () => ({ query: async () => result(), release: () => undefined }),
      end: async () => {
        ended = true
      }
    }
    const runtime = await Runtime.make(PostgresJobStore.layer({ pool, validateSchema: false }))
    const resolved = await runtime.run(() => ServiceRuntime.resolve(JobStore))
    expect(resolved).toBeDefined()
    await runtime.dispose()
    expect(ended).toBe(false)
  })

  test('Layer validates the schema during provider acquisition by default', async () => {
    const { pool } = fakePool()
    const runtime = await Runtime.make(PostgresJobStore.layer({ pool }))
    try {
      // oxlint-disable-next-line typescript/await-thenable -- Bun's rejection matcher is thenable at runtime.
      await expect(runtime.run(() => ServiceRuntime.resolve(JobStore))).rejects.toMatchObject({
        cause: expect.any(PostgresSchemaValidationError)
      })
    } finally {
      await runtime.dispose()
    }
  })

  test('migration is locked, explicit, and idempotency metadata is bound', async () => {
    const { pool, queries } = fakePool({ validSchema: true })
    const first = await PostgresMigrator.run(pool, { appliedAtMs: 1 })
    expect(first).toMatchObject({ applied: [1], version: 1, schema: 'public' })
    expect(queries.some(({ sql }) => sql.includes('pg_advisory_xact_lock'))).toBe(true)
    expect(queries.some(({ sql }) => sql.includes('DROP TABLE'))).toBe(false)
    const lock = queries.find(({ sql }) => sql.includes('pg_advisory_xact_lock'))
    expect(lock?.values).toEqual(['better-effect-mq:public'])
    expect(queries.at(-1)?.sql).toBe('COMMIT')
  })

  test('rejects a migration checksum mismatch without applying SQL', async () => {
    const { pool, queries } = fakePool({ version: { version: 1, checksum: 'tampered' } })
    await expectRejects(PostgresMigrator.run(pool, { appliedAtMs: 1 }), PostgresMigrationError)
    expect(
      queries.some(({ sql }) =>
        sql.includes('CREATE TABLE IF NOT EXISTS "public".better_effect_mq_jobs')
      )
    ).toBe(false)
    expect(queries.at(-1)?.sql).toBe('ROLLBACK')
  })

  test('validation rejects an invalid index catalog entry', async () => {
    const { pool } = fakePool({ validSchema: true, invalidIndex: POSTGRES_INDEXES[0] })
    await expectRejects(PostgresMigrator.validate(pool), PostgresSchemaValidationError)
  })

  test('validation rejects incompatible primary and foreign-key columns', async () => {
    const invalidPrimary = fakePool({
      validSchema: true,
      invalidConstraint: 'better_effect_mq_jobs_pkey'
    })
    await expectRejects(
      PostgresMigrator.validate(invalidPrimary.pool),
      PostgresSchemaValidationError
    )

    const invalidForeignKey = fakePool({
      validSchema: true,
      invalidConstraint: 'better_effect_mq_attempts_job_fk'
    })
    await expectRejects(
      PostgresMigrator.validate(invalidForeignKey.pool),
      PostgresSchemaValidationError
    )

    const reorderedPrimary = fakePool({
      validSchema: true,
      invalidConstraint: 'better_effect_mq_jobs_pkey',
      invalidConstraintColumns: [1, 3]
    })
    await expectRejects(
      PostgresMigrator.validate(reorderedPrimary.pool),
      PostgresSchemaValidationError
    )

    const reorderedForeignKey = fakePool({
      validSchema: true,
      invalidConstraint: 'better_effect_mq_attempts_job_fk',
      invalidReferencedConstraintColumns: [1, 3]
    })
    await expectRejects(
      PostgresMigrator.validate(reorderedForeignKey.pool),
      PostgresSchemaValidationError
    )
  })

  test('validation is read-only and reports missing tables', async () => {
    const { pool, queries } = fakePool()
    await expectRejects(PostgresMigrator.validate(pool), PostgresSchemaValidationError)
    expect(queries.every(({ sql }) => !/^(INSERT|UPDATE|DELETE|CREATE|DROP)/u.test(sql))).toBe(true)
  })

  test('rejects invalid configuration at the boundary', () => {
    expect(() =>
      normalizePostgresJobStoreConfig({ pool: {} as Pool, schema: 'public.foo' })
    ).toThrow(PostgresConfigurationError)
    expect(() => normalizePostgresJobStoreConfig({ pool: {} as Pool, namespace: '' })).toThrow(
      PostgresConfigurationError
    )
  })
})
