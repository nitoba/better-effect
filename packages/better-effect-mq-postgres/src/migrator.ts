// oxlint-disable anti-slop/no-unknown-parameters -- PostgreSQL system-catalog rows are narrowed by validators below.
// oxlint-disable anti-slop/no-runtime-typeof -- system-catalog array values are normalized before comparison.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- migration option snapshots are constrained to known keys.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- option and catalog values are narrowed at their boundaries.

import {
  DEFAULT_SCHEMA,
  validateNamespace,
  validateSchema,
  type Pool,
  type PoolClient
} from './config'
import { PostgresClient } from './client'
import {
  PostgresConfigurationError,
  PostgresMigrationError,
  PostgresSchemaValidationError,
  redactedPostgresError
} from './errors'
import {
  MIGRATION_COMPONENT,
  POSTGRES_INDEXES,
  POSTGRES_TABLES,
  loadPostgresMigrations,
  migrationManifestChecksum,
  migrationSql,
  quoteIdentifier,
  type PostgresMigration
} from './schema'

export interface PostgresMigrationOptions {
  readonly schema?: string
  readonly component?: string
  readonly appliedAtMs?: number
}

export interface PostgresMigrationResult {
  readonly component: string
  readonly schema: string
  readonly version: number
  readonly applied: readonly number[]
}

export interface PostgresSchemaValidationResult {
  readonly component: string
  readonly schema: string
  readonly version: number
}

const readMigrationOptions = (
  value: unknown,
  allowAppliedAtMs = true
): PostgresMigrationOptions => {
  if (value === null || typeof value !== 'object') {
    throw new PostgresConfigurationError('migration options must be an object', 'options')
  }
  try {
    if (Array.isArray(value)) {
      throw new PostgresConfigurationError('migration options must be an object', 'options')
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new PostgresConfigurationError('migration options must be a plain object', 'options')
    }
    const snapshot = Object.create(null) as Record<string, unknown>
    const allowed = new Set(
      allowAppliedAtMs ? ['schema', 'component', 'appliedAtMs'] : ['schema', 'component']
    )
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !allowed.has(key)) {
        throw new PostgresConfigurationError('contains unsupported fields', 'options')
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !('value' in descriptor)) {
        throw new PostgresConfigurationError('must contain data properties', key)
      }
      snapshot[key] = descriptor.value
    }
    // SAFETY: every own key was checked against the migration option key set and copied from a data descriptor.
    return Object.freeze(snapshot) as PostgresMigrationOptions
  } catch (cause) {
    if (cause instanceof PostgresConfigurationError) throw cause
    throw new PostgresConfigurationError('could not read migration options', 'options')
  }
}

interface VersionRow {
  readonly version: number | string
  readonly checksum: string
}

const requiredColumns = {
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
} as const satisfies Record<string, readonly string[]>

const expectedColumnTypes = {
  [`${POSTGRES_TABLES.jobs}.namespace`]: 'text',
  [`${POSTGRES_TABLES.jobs}.id`]: 'text',
  [`${POSTGRES_TABLES.jobs}.queue`]: 'text',
  [`${POSTGRES_TABLES.jobs}.name`]: 'text',
  [`${POSTGRES_TABLES.jobs}.version`]: 'bigint',
  [`${POSTGRES_TABLES.jobs}.state`]: 'text',
  [`${POSTGRES_TABLES.jobs}.payload`]: 'jsonb',
  [`${POSTGRES_TABLES.jobs}.metadata`]: 'jsonb',
  [`${POSTGRES_TABLES.jobs}.priority`]: 'bigint',
  [`${POSTGRES_TABLES.jobs}.run_at_ms`]: 'bigint',
  [`${POSTGRES_TABLES.jobs}.sequence`]: 'bigint',
  [`${POSTGRES_TABLES.jobs}.attempts_max`]: 'bigint',
  [`${POSTGRES_TABLES.jobs}.attempts_made`]: 'bigint',
  [`${POSTGRES_TABLES.jobs}.delivery_count`]: 'bigint',
  [`${POSTGRES_TABLES.jobs}.stalled_count`]: 'bigint',
  [`${POSTGRES_TABLES.jobs}.attempt_sequence`]: 'bigint',
  [`${POSTGRES_TABLES.jobs}.backoff`]: 'jsonb',
  [`${POSTGRES_TABLES.jobs}.timeout_ms`]: 'bigint',
  [`${POSTGRES_TABLES.jobs}.idempotency_key`]: 'text',
  [`${POSTGRES_TABLES.jobs}.dedupe_key`]: 'text',
  [`${POSTGRES_TABLES.jobs}.created_at_ms`]: 'bigint',
  [`${POSTGRES_TABLES.jobs}.updated_at_ms`]: 'bigint',
  [`${POSTGRES_TABLES.jobs}.processed_at_ms`]: 'bigint',
  [`${POSTGRES_TABLES.jobs}.finished_at_ms`]: 'bigint',
  [`${POSTGRES_TABLES.jobs}.lease_owner`]: 'text',
  [`${POSTGRES_TABLES.jobs}.lease_token`]: 'text',
  [`${POSTGRES_TABLES.jobs}.lease_expires_at_ms`]: 'bigint',
  [`${POSTGRES_TABLES.jobs}.cancel_requested`]: 'boolean',
  [`${POSTGRES_TABLES.jobs}.cancellation_requested_at_ms`]: 'bigint',
  [`${POSTGRES_TABLES.jobs}.result`]: 'jsonb',
  [`${POSTGRES_TABLES.jobs}.failure`]: 'jsonb',
  [`${POSTGRES_TABLES.jobs}.last_settlement_token`]: 'text',
  [`${POSTGRES_TABLES.jobs}.last_settlement_outcome`]: 'text',
  [`${POSTGRES_TABLES.jobs}.last_settlement_attempt_sequence`]: 'bigint',
  [`${POSTGRES_TABLES.attempts}.namespace`]: 'text',
  [`${POSTGRES_TABLES.attempts}.job_id`]: 'text',
  [`${POSTGRES_TABLES.attempts}.ledger_sequence`]: 'bigint',
  [`${POSTGRES_TABLES.attempts}.attempt_sequence`]: 'bigint',
  [`${POSTGRES_TABLES.attempts}.attempt`]: 'bigint',
  [`${POSTGRES_TABLES.attempts}.delivery`]: 'bigint',
  [`${POSTGRES_TABLES.attempts}.started_at_ms`]: 'bigint',
  [`${POSTGRES_TABLES.attempts}.finished_at_ms`]: 'bigint',
  [`${POSTGRES_TABLES.attempts}.outcome`]: 'text',
  [`${POSTGRES_TABLES.attempts}.result`]: 'jsonb',
  [`${POSTGRES_TABLES.attempts}.failure`]: 'jsonb',
  [`${POSTGRES_TABLES.attempts}.worker_id`]: 'text',
  [`${POSTGRES_TABLES.attempts}.retry_at_ms`]: 'bigint',
  [`${POSTGRES_TABLES.attempts}.retry_delay_ms`]: 'bigint',
  [`${POSTGRES_TABLES.queues}.namespace`]: 'text',
  [`${POSTGRES_TABLES.queues}.queue`]: 'text',
  [`${POSTGRES_TABLES.queues}.paused`]: 'boolean',
  [`${POSTGRES_TABLES.queues}.wake_version`]: 'bigint',
  [`${POSTGRES_TABLES.queues}.updated_at_ms`]: 'bigint',
  [`${POSTGRES_TABLES.schemaVersions}.component`]: 'text',
  [`${POSTGRES_TABLES.schemaVersions}.version`]: 'integer',
  [`${POSTGRES_TABLES.schemaVersions}.applied_at_ms`]: 'bigint',
  [`${POSTGRES_TABLES.schemaVersions}.checksum`]: 'text'
} as const satisfies Record<string, string>

const nullableColumns = new Set([
  `${POSTGRES_TABLES.jobs}.backoff`,
  `${POSTGRES_TABLES.jobs}.timeout_ms`,
  `${POSTGRES_TABLES.jobs}.idempotency_key`,
  `${POSTGRES_TABLES.jobs}.dedupe_key`,
  `${POSTGRES_TABLES.jobs}.processed_at_ms`,
  `${POSTGRES_TABLES.jobs}.finished_at_ms`,
  `${POSTGRES_TABLES.jobs}.lease_owner`,
  `${POSTGRES_TABLES.jobs}.lease_token`,
  `${POSTGRES_TABLES.jobs}.lease_expires_at_ms`,
  `${POSTGRES_TABLES.jobs}.cancellation_requested_at_ms`,
  `${POSTGRES_TABLES.jobs}.result`,
  `${POSTGRES_TABLES.jobs}.failure`,
  `${POSTGRES_TABLES.jobs}.last_settlement_token`,
  `${POSTGRES_TABLES.jobs}.last_settlement_outcome`,
  `${POSTGRES_TABLES.jobs}.last_settlement_attempt_sequence`,
  `${POSTGRES_TABLES.attempts}.attempt_sequence`,
  `${POSTGRES_TABLES.attempts}.started_at_ms`,
  `${POSTGRES_TABLES.attempts}.result`,
  `${POSTGRES_TABLES.attempts}.failure`,
  `${POSTGRES_TABLES.attempts}.worker_id`,
  `${POSTGRES_TABLES.attempts}.retry_at_ms`,
  `${POSTGRES_TABLES.attempts}.retry_delay_ms`
])

type PostgresIndexName = (typeof POSTGRES_INDEXES)[number]

const expectedIndexFragments = {
  [POSTGRES_INDEXES[0]]: [
    'namespace',
    'queue',
    'priority DESC',
    'run_at_ms',
    'sequence',
    'id COLLATE "C"'
  ],
  [POSTGRES_INDEXES[1]]: [
    'namespace',
    'state',
    'lease_expires_at_ms',
    'WHERE',
    'state =',
    'active'
  ],
  [POSTGRES_INDEXES[2]]: ['namespace', 'queue', 'name', 'version', 'state'],
  [POSTGRES_INDEXES[3]]: ['created_at_ms DESC', 'sequence DESC', 'id COLLATE "C"'],
  [POSTGRES_INDEXES[4]]: ['namespace', 'queue', 'state', 'run_at_ms', 'sequence', 'id COLLATE "C"'],
  [POSTGRES_INDEXES[5]]: [
    'namespace',
    'state',
    'finished_at_ms DESC',
    'sequence DESC',
    'id COLLATE "C"',
    'WHERE',
    'state = ANY',
    'completed',
    'failed',
    'cancelled'
  ],
  [POSTGRES_INDEXES[6]]: ['USING gin', 'metadata jsonb_path_ops'],
  [POSTGRES_INDEXES[7]]: [
    'CREATE UNIQUE INDEX',
    'namespace',
    'queue',
    'name',
    'version',
    'dedupe_key',
    'WHERE',
    'dedupe_key IS NOT NULL'
  ]
} as const satisfies Partial<Record<PostgresIndexName, readonly string[]>>

const requiredConstraints = [
  'better_effect_mq_jobs_pkey',
  'better_effect_mq_jobs_nonempty',
  'better_effect_mq_jobs_state',
  'better_effect_mq_jobs_version',
  'better_effect_mq_jobs_counters',
  'better_effect_mq_jobs_epoch_ms',
  'better_effect_mq_jobs_metadata_values',
  'better_effect_mq_jobs_tokens',
  'better_effect_mq_jobs_active_lease',
  'better_effect_mq_jobs_cancel_requested',
  'better_effect_mq_jobs_terminal_time',
  'better_effect_mq_jobs_settlement_pair',
  'better_effect_mq_attempts_pkey',
  'better_effect_mq_attempts_job_fk',
  'better_effect_mq_attempts_values',
  'better_effect_mq_attempts_tokens',
  'better_effect_mq_attempts_retry',
  'better_effect_mq_attempts_outcome',
  'better_effect_mq_attempts_times',
  'better_effect_mq_queues_pkey',
  'better_effect_mq_queues_values',
  'better_effect_mq_schema_versions_pkey',
  'better_effect_mq_schema_versions_values'
] as const

type PostgresConstraintName = (typeof requiredConstraints)[number]

const expectedConstraintTypes = {
  [requiredConstraints[0]]: 'p',
  [requiredConstraints[12]]: 'p',
  [requiredConstraints[13]]: 'f',
  [requiredConstraints[19]]: 'p',
  [requiredConstraints[21]]: 'p'
} satisfies Partial<Record<PostgresConstraintName, 'p' | 'f'>>

const expectedConstraintColumns = {
  [requiredConstraints[0]]: { local: ['namespace', 'id'] },
  [requiredConstraints[12]]: { local: ['namespace', 'job_id', 'ledger_sequence'] },
  [requiredConstraints[13]]: {
    local: ['namespace', 'job_id'],
    referenced: ['namespace', 'id']
  },
  [requiredConstraints[19]]: { local: ['namespace', 'queue'] },
  [requiredConstraints[21]]: { local: ['component'] }
} satisfies Partial<
  Record<
    PostgresConstraintName,
    { readonly local: readonly string[]; readonly referenced?: readonly string[] }
  >
>

const expectedConstraintDefinitions = {
  [requiredConstraints[1]]: `CHECK (((namespace <> '') AND (id <> '') AND (queue <> '') AND (name <> '')))`,
  [requiredConstraints[2]]: `CHECK ((state = ANY (ARRAY['waiting', 'delayed', 'active', 'completed', 'failed', 'cancelled'])))`,
  [requiredConstraints[3]]: `CHECK ((version > 0))`,
  [requiredConstraints[4]]: `CHECK (((attempts_max >= 1) AND (attempts_made >= 0) AND (attempts_made <= attempts_max) AND (attempts_made <= delivery_count) AND (delivery_count >= 0) AND (stalled_count >= 0) AND (attempt_sequence >= attempts_made) AND ((state <> ALL (ARRAY['waiting', 'delayed', 'active'])) OR (attempts_made < attempts_max)) AND ((state <> 'active') OR (attempts_made < delivery_count))))`,
  [requiredConstraints[5]]: `CHECK ((((run_at_ms >= 0) AND (run_at_ms <= '9007199254740991')) AND ((created_at_ms >= 0) AND (created_at_ms <= '9007199254740991')) AND ((updated_at_ms >= 0) AND (updated_at_ms <= '9007199254740991')) AND ((timeout_ms IS NULL) OR ((timeout_ms >= 1) AND (timeout_ms <= '9007199254740991'))) AND ((processed_at_ms IS NULL) OR ((processed_at_ms >= 0) AND (processed_at_ms <= '9007199254740991'))) AND ((finished_at_ms IS NULL) OR ((finished_at_ms >= 0) AND (finished_at_ms <= '9007199254740991'))) AND ((lease_expires_at_ms IS NULL) OR ((lease_expires_at_ms >= 0) AND (lease_expires_at_ms <= '9007199254740991'))) AND ((cancellation_requested_at_ms IS NULL) OR ((cancellation_requested_at_ms >= 0) AND (cancellation_requested_at_ms <= '9007199254740991')))))`,
  [requiredConstraints[6]]: `CHECK (((jsonb_typeof(metadata) = 'object') AND (NOT jsonb_path_exists(metadata, '$.*?(@.type() != "string")'))))`,
  [requiredConstraints[7]]: `CHECK ((((idempotency_key IS NULL) OR (idempotency_key <> '')) AND ((dedupe_key IS NULL) OR (dedupe_key <> '')) AND ((lease_owner IS NULL) OR (lease_owner <> '')) AND ((lease_token IS NULL) OR (lease_token <> '')) AND ((last_settlement_token IS NULL) OR (last_settlement_token <> ''))))`,
  [requiredConstraints[8]]: `CHECK ((((state = 'active') AND (lease_owner IS NOT NULL) AND (lease_owner <> '') AND (lease_token IS NOT NULL) AND (lease_token <> '') AND (lease_expires_at_ms IS NOT NULL)) OR ((state <> 'active') AND (lease_owner IS NULL) AND (lease_token IS NULL) AND (lease_expires_at_ms IS NULL))))`,
  [requiredConstraints[9]]: `CHECK (((cancel_requested = (cancellation_requested_at_ms IS NOT NULL)) AND ((state = 'active') OR (cancellation_requested_at_ms IS NULL))))`,
  [requiredConstraints[10]]: `CHECK (((state <> ALL (ARRAY['completed', 'failed', 'cancelled'])) OR (finished_at_ms IS NOT NULL)))`,
  [requiredConstraints[11]]: `CHECK ((((last_settlement_token IS NULL) AND (last_settlement_outcome IS NULL) AND (last_settlement_attempt_sequence IS NULL)) OR ((last_settlement_token IS NOT NULL) AND (last_settlement_outcome IS NOT NULL) AND (last_settlement_attempt_sequence IS NOT NULL))))`,
  [requiredConstraints[14]]: `CHECK (((namespace <> '') AND (job_id <> '') AND (attempt >= 1) AND (delivery >= 1)))`,
  [requiredConstraints[15]]: `CHECK (((worker_id IS NULL) OR (worker_id <> '')))`,
  [requiredConstraints[16]]: `CHECK ((((outcome = 'retried') AND (retry_at_ms IS NOT NULL) AND (retry_delay_ms IS NOT NULL)) OR ((outcome <> 'retried') AND (retry_at_ms IS NULL) AND (retry_delay_ms IS NULL))))`,
  [requiredConstraints[17]]: `CHECK ((outcome = ANY (ARRAY['completed', 'retried', 'failed', 'cancelled', 'stalled', 'released'])))`,
  [requiredConstraints[18]]: `CHECK ((((started_at_ms IS NULL) OR ((started_at_ms >= 0) AND (started_at_ms <= '9007199254740991'))) AND ((finished_at_ms >= 0) AND (finished_at_ms <= '9007199254740991')) AND ((retry_at_ms IS NULL) OR ((retry_at_ms >= 0) AND (retry_at_ms <= '9007199254740991'))) AND ((retry_delay_ms IS NULL) OR ((retry_delay_ms >= 0) AND (retry_delay_ms <= '9007199254740991'))) AND ((attempt_sequence IS NULL) OR (attempt_sequence = attempt)) AND ((started_at_ms IS NULL) OR (started_at_ms <= finished_at_ms))))`,
  [requiredConstraints[20]]: `CHECK (((namespace <> '') AND (queue <> '') AND ((wake_version >= 0) AND (wake_version <= '9007199254740991')) AND ((updated_at_ms >= 0) AND (updated_at_ms <= '9007199254740991'))))`,
  [requiredConstraints[22]]: `CHECK (((component <> '') AND (version >= 0) AND ((applied_at_ms >= 0) AND (applied_at_ms <= '9007199254740991')) AND (checksum <> '')))`
} satisfies Partial<Record<PostgresConstraintName, string>>

const expectedConstraintType = (constraint: PostgresConstraintName): 'p' | 'f' | undefined => {
  // SAFETY: the lookup key is validated against the required constraint-name union.
  return expectedConstraintTypes[constraint as keyof typeof expectedConstraintTypes]
}

const expectedConstraintDefinition = (constraint: PostgresConstraintName): string | undefined => {
  // SAFETY: the lookup key is validated against the required constraint-name union.
  return expectedConstraintDefinitions[constraint as keyof typeof expectedConstraintDefinitions]
}

const expectedConstraintColumn = (
  constraint: PostgresConstraintName
):
  | {
      readonly local: readonly string[]
      readonly referenced?: readonly string[]
    }
  | undefined => {
  // SAFETY: the lookup key is validated against the required constraint-name union.
  return expectedConstraintColumns[constraint as keyof typeof expectedConstraintColumns]
}

const normalizeConstraintDefinition = (definition: string): string =>
  definition
    .toLowerCase()
    .replace(/\s+/gu, '')
    .replace(/::[a-z_][a-z0-9_]*(?:\[\])?/gu, '')
    .replace(/(['"])(\d+)\1/gu, '$2')

const normalizeConstraintColumns = (value: unknown): readonly number[] | undefined => {
  try {
    if (!Array.isArray(value)) return undefined
    const columns = value.map((column) => (typeof column === 'number' ? column : Number(column)))
    return columns.every((column) => Number.isSafeInteger(column) && column > 0)
      ? columns
      : undefined
  } catch {
    return undefined
  }
}

const sameColumns = (
  actual: unknown,
  expected: readonly string[],
  table: string,
  attributes: ReadonlyMap<string, string>
): boolean => {
  const columns = normalizeConstraintColumns(actual)
  return (
    columns !== undefined &&
    columns.length === expected.length &&
    columns.every((column, i) => attributes.get(`${table}:${column}`) === expected[i])
  )
}

const rowTableForConstraint = (constraint: string): string => {
  if (constraint.startsWith('better_effect_mq_jobs_')) return POSTGRES_TABLES.jobs
  if (constraint.startsWith('better_effect_mq_attempts_')) return POSTGRES_TABLES.attempts
  if (constraint.startsWith('better_effect_mq_queues_')) return POSTGRES_TABLES.queues
  return POSTGRES_TABLES.schemaVersions
}

const getPool = (value: Pool | PostgresClient): Pool =>
  value instanceof PostgresClient ? value.pool : value

const getSchema = (value: Pool | PostgresClient, schema: string | undefined): string =>
  validateSchema(
    schema === undefined
      ? value instanceof PostgresClient
        ? value.schema
        : DEFAULT_SCHEMA
      : schema
  )

const getComponent = (component: string | undefined): string =>
  validateNamespace(component === undefined ? MIGRATION_COMPONENT : component)

const migrationHint = (schema: string): string =>
  `run PostgresMigrator.run(pool, { schema: '${schema}' })`

const requireEpochMs = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('appliedAtMs must be a non-negative safe integer')
  }
  return value
}

const queryVersions = async (client: PoolClient, schema: string, component: string) => {
  const result = await client.query<VersionRow>(
    `SELECT version, checksum FROM ${quoteIdentifier(schema)}.${POSTGRES_TABLES.schemaVersions} WHERE component = $1`,
    [component]
  )
  return result.rows[0]
}

const queryOtherComponent = async (
  client: PoolClient,
  schema: string,
  component: string
): Promise<string | undefined> => {
  const result = await client.query<{ component: string }>(
    `SELECT component FROM ${quoteIdentifier(schema)}.${POSTGRES_TABLES.schemaVersions} WHERE component <> $1 LIMIT 1`,
    [component]
  )
  return result.rows[0]?.component
}

const checkVersionRow = (
  row: VersionRow | undefined,
  migrations: readonly PostgresMigration[],
  component: string
): number => {
  if (row === undefined) return 0
  const version = Number(row.version)
  const latest = migrations.at(-1)?.version ?? 0
  if (!Number.isSafeInteger(version) || version < 0 || version > latest) {
    throw new PostgresMigrationError(
      `Migration version for ${component} is outside the supported range`
    )
  }
  const expected = migrationManifestChecksum(migrations, version)
  if (version > 0 && row.checksum !== expected) {
    throw new PostgresMigrationError(
      `Migration checksum mismatch for ${component} at version ${version}`
    )
  }
  return version
}

const beginMigration = async (
  pool: Pool,
  schema: string
): Promise<{ client: PoolClient; migrations: readonly PostgresMigration[] }> => {
  const migrations = await loadPostgresMigrations()
  let client: PoolClient
  try {
    client = await pool.connect()
  } catch (cause) {
    throw redactedPostgresError('connection acquisition', cause)
  }
  try {
    await client.query('BEGIN')
    // All components target the same physical schema, so they must share one lock.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${MIGRATION_COMPONENT}:${schema}`
    ])
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)}`)
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(schema)}.${POSTGRES_TABLES.schemaVersions} (component text PRIMARY KEY, version integer NOT NULL, applied_at_ms bigint NOT NULL, checksum text NOT NULL, CONSTRAINT better_effect_mq_schema_versions_values CHECK (component <> '' AND version >= 0 AND applied_at_ms BETWEEN 0 AND 9007199254740991 AND checksum <> ''))`
    )
    return { client, migrations }
  } catch (cause) {
    let rollbackFailure: unknown
    try {
      await client.query('ROLLBACK')
    } catch (failure) {
      rollbackFailure = failure
    }
    try {
      client.release(
        rollbackFailure === undefined
          ? undefined
          : rollbackFailure instanceof Error
            ? rollbackFailure
            : new Error('PostgreSQL migration rollback failed', { cause: rollbackFailure })
      )
    } catch {
      // Preserve the setup failure as the primary error.
    }
    throw redactedPostgresError('migration setup', cause)
  }
}

const asError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error('PostgreSQL migration failed', { cause })

const rollback = async (
  client: PoolClient,
  cause: unknown
): Promise<{ readonly error: Error; readonly failed: boolean }> => {
  const primary = asError(cause)
  try {
    await client.query('ROLLBACK')
    return { error: primary, failed: false }
  } catch (rollbackCause) {
    return {
      error: new AggregateError(
        [primary, asError(rollbackCause)],
        'PostgreSQL migration rollback failed'
      ),
      failed: true
    }
  }
}

const runMigration = async (
  client: PoolClient,
  schema: string,
  component: string,
  appliedAtMs: number,
  migrations: readonly PostgresMigration[]
): Promise<PostgresMigrationResult> => {
  const otherComponent = await queryOtherComponent(client, schema, component)
  if (otherComponent !== undefined) {
    throw new PostgresMigrationError(
      `PostgreSQL schema ${schema} is already owned by migration component ${otherComponent}`
    )
  }
  const row = await queryVersions(client, schema, component)
  const currentVersion = checkVersionRow(row, migrations, component)
  const applied: number[] = []
  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue
    await client.query(migrationSql(migration, schema))
    await client.query(
      `INSERT INTO ${quoteIdentifier(schema)}.${POSTGRES_TABLES.schemaVersions} (component, version, applied_at_ms, checksum) VALUES ($1, $2, $3, $4) ON CONFLICT (component) DO UPDATE SET version = EXCLUDED.version, applied_at_ms = EXCLUDED.applied_at_ms, checksum = EXCLUDED.checksum`,
      [
        component,
        migration.version,
        appliedAtMs,
        migrationManifestChecksum(migrations, migration.version)
      ]
    )
    applied.push(migration.version)
  }
  const problems = await findSchemaProblems(client, schema)
  if (problems.length > 0) {
    throw new PostgresMigrationError(
      `PostgreSQL schema validation failed after migration: ${problems.join('; ')}`
    )
  }
  await client.query('COMMIT')
  return {
    applied,
    component,
    schema,
    version: migrations.at(-1)?.version ?? 0
  }
}

export const PostgresMigrator = {
  async run(
    poolOrClient: Pool | PostgresClient,
    options: PostgresMigrationOptions = {}
  ): Promise<PostgresMigrationResult> {
    const input = readMigrationOptions(options)
    const schema = getSchema(poolOrClient, input.schema)
    const component = getComponent(input.component)
    const appliedAtMs = requireEpochMs(
      input.appliedAtMs === undefined ? Date.now() : input.appliedAtMs
    )
    const pool = getPool(poolOrClient)
    const { client, migrations } = await beginMigration(pool, schema)
    let result: PostgresMigrationResult | undefined
    let failure: Error | undefined
    let rollbackFailed = false
    try {
      result = await runMigration(client, schema, component, appliedAtMs, migrations)
    } catch (cause) {
      const rolledBack = await rollback(client, cause)
      failure = rolledBack.error
      rollbackFailed = rolledBack.failed
    }
    let releaseFailure: unknown
    try {
      client.release(rollbackFailed ? failure : undefined)
    } catch (cause) {
      releaseFailure = cause
    }
    if (failure !== undefined) {
      throw failure instanceof PostgresMigrationError
        ? failure
        : redactedPostgresError('migration', failure)
    }
    if (releaseFailure !== undefined)
      throw redactedPostgresError('connection release', releaseFailure)
    return result as PostgresMigrationResult
  },

  async validate(
    poolOrClient: Pool | PostgresClient,
    options: Pick<PostgresMigrationOptions, 'schema' | 'component'> = {}
  ): Promise<PostgresSchemaValidationResult> {
    const input = readMigrationOptions(options, false)
    const schema = getSchema(poolOrClient, input.schema)
    const component = getComponent(input.component)
    const pool = getPool(poolOrClient)
    let client: PoolClient
    try {
      client = await pool.connect()
    } catch (cause) {
      throw redactedPostgresError('connection acquisition', cause)
    }
    let result: PostgresSchemaValidationResult | undefined
    let failure: unknown
    let failed = false
    try {
      const problems = await findSchemaProblems(client, schema)
      if (problems.length > 0) {
        throw new PostgresSchemaValidationError(
          `PostgreSQL schema validation failed: ${problems.join('; ')}; ${migrationHint(schema)}`,
          problems
        )
      }
      const otherComponent = await queryOtherComponent(client, schema, component)
      if (otherComponent !== undefined) {
        throw new PostgresMigrationError(
          `PostgreSQL schema ${schema} is owned by migration component ${otherComponent}`
        )
      }
      const row = await queryVersions(client, schema, component)
      const migrations = await loadPostgresMigrations()
      const version = checkVersionRow(row, migrations, component)
      if (version !== (migrations.at(-1)?.version ?? 0)) {
        throw new PostgresSchemaValidationError(
          `PostgreSQL schema is not migrated to the latest version (expected ${migrations.at(-1)?.version ?? 0}, found ${version}); ${migrationHint(schema)}`
        )
      }
      result = { component, schema, version }
    } catch (cause) {
      failed = true
      failure = cause
    }
    let releaseFailure: unknown
    try {
      client.release()
    } catch (cause) {
      releaseFailure = cause
    }
    if (failed) {
      if (failure instanceof PostgresSchemaValidationError) throw failure
      if (failure instanceof PostgresMigrationError) {
        throw new PostgresSchemaValidationError(failure.message, [failure.message])
      }
      throw redactedPostgresError('schema validation', failure)
    }
    if (releaseFailure !== undefined)
      throw redactedPostgresError('connection release', releaseFailure)
    return result as PostgresSchemaValidationResult
  }
}

const findSchemaProblems = async (
  client: PoolClient,
  schema: string
): Promise<readonly string[]> => {
  const tableNames = Object.values(POSTGRES_TABLES)
  const tableResult = await client.query<{ table_name: string }>(
    'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = ANY($2::text[])',
    [schema, tableNames]
  )
  const foundTables = new Set(tableResult.rows.map((row) => row.table_name))
  const problems: string[] = tableNames
    .filter((table) => !foundTables.has(table))
    .map((table) => `missing table ${table}`)
  if (problems.length > 0) return problems

  const columnResult = await client.query<{
    table_name: string
    column_name: string
    data_type?: string
    is_nullable?: string
    identity_generation?: string | null
  }>(
    'SELECT table_name, column_name, data_type, is_nullable, identity_generation FROM information_schema.columns WHERE table_schema = $1',
    [schema]
  )
  const columns = new Map(
    columnResult.rows.map((row) => [
      `${row.table_name}.${row.column_name}`,
      {
        dataType: row.data_type,
        nullable: row.is_nullable,
        identity: row.identity_generation
      }
    ])
  )
  for (const [table, names] of Object.entries(requiredColumns)) {
    for (const name of names) {
      const key = `${table}.${name}`
      const column = columns.get(key)
      if (column === undefined) {
        problems.push(`missing column ${key}`)
        continue
      }
      const expectedType = expectedColumnTypes[key]
      if (
        expectedType !== undefined &&
        column.dataType !== undefined &&
        column.dataType !== expectedType
      ) {
        problems.push(
          `incompatible column ${key} (expected ${expectedType}, found ${column.dataType})`
        )
      }
      if (
        column.nullable !== undefined &&
        ((nullableColumns.has(key) && column.nullable !== 'YES') ||
          (!nullableColumns.has(key) && column.nullable !== 'NO'))
      ) {
        problems.push(`incompatible nullability ${key}`)
      }
      if (
        (name === 'sequence' && table === POSTGRES_TABLES.jobs) ||
        (name === 'ledger_sequence' && table === POSTGRES_TABLES.attempts)
      ) {
        const expectedIdentity =
          name === 'sequence' && table === POSTGRES_TABLES.jobs ? 'BY DEFAULT' : 'ALWAYS'
        if (column.identity !== undefined && column.identity !== expectedIdentity) {
          problems.push(`incompatible identity ${key}`)
        }
      }
    }
  }

  const indexResult = await client.query<{
    indexname: string
    tablename?: string
    indexdef?: string
    is_valid?: boolean
    is_ready?: boolean
    is_unique?: boolean
    access_method?: string
  }>(
    'SELECT p.indexname, p.tablename, p.indexdef, i.indisvalid AS is_valid, i.indisready AS is_ready, i.indisunique AS is_unique, am.amname AS access_method FROM pg_indexes p JOIN pg_class idx ON idx.relname = p.indexname JOIN pg_namespace idxn ON idxn.oid = idx.relnamespace AND idxn.nspname = p.schemaname JOIN pg_index i ON i.indexrelid = idx.oid JOIN pg_am am ON am.oid = idx.relam WHERE p.schemaname = $1',
    [schema]
  )
  const indexes = new Map(
    indexResult.rows.map((row) => [
      row.indexname,
      {
        table: row.tablename,
        definition: row.indexdef,
        valid: row.is_valid,
        ready: row.is_ready,
        unique: row.is_unique,
        accessMethod: row.access_method
      }
    ])
  )
  for (const index of POSTGRES_INDEXES) {
    const entry = indexes.get(index)
    if (entry === undefined) {
      problems.push(`missing index ${index}`)
      continue
    }
    const definition = entry.definition
    const fragments = expectedIndexFragments[index]
    const normalizedDefinition = definition?.toLowerCase() ?? ''
    let definitionOffset = 0
    const fragmentsInOrder =
      fragments !== undefined &&
      fragments.every((fragment) => {
        const offset = normalizedDefinition.indexOf(fragment.toLowerCase(), definitionOffset)
        if (offset < 0) return false
        definitionOffset = offset + fragment.length
        return true
      })
    const incompatibleDefinition = definition === undefined || !fragmentsInOrder
    const incompatibleCatalog =
      entry.table !== POSTGRES_TABLES.jobs ||
      entry.valid !== true ||
      entry.ready !== true ||
      entry.accessMethod !== (index === POSTGRES_INDEXES[6] ? 'gin' : 'btree') ||
      entry.unique !== (index === POSTGRES_INDEXES[7])
    if (incompatibleDefinition || incompatibleCatalog) {
      problems.push(`incompatible index ${index}`)
    }
  }

  const attributeResult = await client.query<{
    table_name: string
    attnum: number | string
    attname: string
  }>(
    'SELECT cls.relname AS table_name, a.attnum, a.attname FROM pg_attribute a JOIN pg_class cls ON cls.oid = a.attrelid JOIN pg_namespace n ON n.oid = cls.relnamespace WHERE n.nspname = $1 AND cls.relname = ANY($2::text[]) AND a.attnum > 0 AND NOT a.attisdropped',
    [schema, tableNames]
  )
  const attributes = new Map<string, string>()
  for (const row of attributeResult.rows) {
    const attnum = Number(row.attnum)
    if (
      typeof row.table_name === 'string' &&
      typeof row.attname === 'string' &&
      Number.isSafeInteger(attnum) &&
      attnum > 0
    ) {
      attributes.set(`${row.table_name}:${attnum}`, row.attname)
    }
  }

  const constraintResult = await client.query<{
    conname: string
    table_name?: string
    constraint_type?: string
    validated?: boolean
    definition?: string
    referenced_schema?: string
    referenced_table?: string
    delete_action?: string
    conkey?: readonly number[] | null
    confkey?: readonly number[] | null
  }>(
    'SELECT c.conname, cls.relname AS table_name, c.contype AS constraint_type, c.convalidated AS validated, pg_get_constraintdef(c.oid) AS definition, c.conkey, c.confkey, refn.nspname AS referenced_schema, refcls.relname AS referenced_table, c.confdeltype AS delete_action FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace JOIN pg_class cls ON cls.oid = c.conrelid JOIN pg_namespace tabn ON tabn.oid = cls.relnamespace AND tabn.nspname = $1 LEFT JOIN pg_class refcls ON refcls.oid = c.confrelid LEFT JOIN pg_namespace refn ON refn.oid = refcls.relnamespace WHERE n.nspname = $1',
    [schema]
  )
  const constraints = new Map(
    constraintResult.rows.map((row) => [
      row.conname,
      {
        table: row.table_name,
        type: row.constraint_type,
        validated: row.validated,
        definition: row.definition,
        referencedSchema: row.referenced_schema,
        referencedTable: row.referenced_table,
        deleteAction: row.delete_action,
        localColumns: row.conkey,
        referencedColumns: row.confkey
      }
    ])
  )
  for (const constraint of requiredConstraints) {
    const entry = constraints.get(constraint)
    if (entry === undefined) {
      problems.push(`missing constraint ${constraint}`)
      continue
    }
    const expectedType = expectedConstraintType(constraint)
    const expectedTable = rowTableForConstraint(constraint)
    const wrongForeignKeyTarget =
      constraint === requiredConstraints[13] &&
      (entry.referencedSchema !== schema ||
        entry.referencedTable !== POSTGRES_TABLES.jobs ||
        entry.deleteAction !== 'c')
    const expectedColumns = expectedConstraintColumn(constraint)
    const wrongConstraintColumns =
      expectedColumns !== undefined &&
      (!sameColumns(entry.localColumns, expectedColumns.local, expectedTable, attributes) ||
        (expectedColumns.referenced !== undefined &&
          !sameColumns(
            entry.referencedColumns,
            expectedColumns.referenced,
            POSTGRES_TABLES.jobs,
            attributes
          )))
    if (
      entry.table !== expectedTable ||
      (expectedType !== undefined && entry.type !== expectedType) ||
      entry.validated !== true ||
      wrongForeignKeyTarget ||
      wrongConstraintColumns
    ) {
      problems.push(`incompatible constraint ${constraint}`)
      continue
    }
    const expectedDefinition = expectedConstraintDefinition(constraint)
    const incompatibleDefinition =
      expectedDefinition !== undefined &&
      (entry.definition === undefined ||
        normalizeConstraintDefinition(entry.definition) !==
          normalizeConstraintDefinition(expectedDefinition))
    if (incompatibleDefinition) {
      problems.push(`incompatible constraint ${constraint}`)
    }
  }
  return problems
}

export type { PoolClient as PostgresPoolClient }
export type { PostgresMigration } from './schema'
