import { PGlite } from '@electric-sql/pglite'
import { expect, test } from 'bun:test'
import { Layer, Runtime, ServiceRuntime } from 'better-effect'
import { Result, type Result as ResultType } from 'better-result'

import {
  JobName,
  JobScheduleStore,
  JobStore,
  QueueName,
  makeJobId,
  type JobIdentity,
  type ScheduleRecord,
  type TickScheduleCommand
} from 'better-effect-mq'
import {
  PostgresClient,
  PostgresJobScheduleStore,
  PostgresJobStore,
  type Pool,
  type PoolClient,
  type QueryResult
} from '../src'

type PGliteDatabase = Awaited<ReturnType<typeof PGlite.create>>

type PGliteResult<Row> = {
  readonly rows: readonly Row[]
  readonly affectedRows?: number
}

const runQuery = async <Row>(
  database: PGliteDatabase,
  text: string,
  values: readonly unknown[] | undefined
): Promise<PGliteResult<Row>> => {
  if (values !== undefined) {
    // SAFETY: PGlite returns the structural query result consumed by this Pool bridge.
    return database.query(text, [...values]) as Promise<PGliteResult<Row>>
  }
  if (/^\s*(SELECT|WITH)/iu.test(text)) {
    // SAFETY: PGlite returns the structural query result consumed by this Pool bridge.
    return database.query(text) as Promise<PGliteResult<Row>>
  }
  await database.exec(text)
  return { rows: [] }
}

const makePool = async (): Promise<{ readonly database: PGliteDatabase; readonly pool: Pool }> => {
  const database = await PGlite.create('memory://')
  return {
    database,
    pool: {
      connect: async (): Promise<PoolClient> => ({
        query: async <Row>(
          text: string,
          values?: readonly unknown[]
        ): Promise<QueryResult<Row>> => {
          const result = await runQuery<Row>(database, text, values)
          return {
            rows: result.rows,
            rowCount: result.affectedRows ?? result.rows.length
          }
        },
        release: () => undefined
      })
    }
  }
}

const resolve = async <Value, Failure>(
  operation: ResultType<Value, Failure> | PromiseLike<ResultType<Value, Failure>>
): Promise<Value> => {
  const result = await operation
  if (Result.isError(result)) throw result.error
  return result.value
}

const identity = {
  queue: QueueName.make('billing').unwrap(),
  name: JobName.make('invoice').unwrap(),
  version: 2
} satisfies JobIdentity

const record = (overrides: Partial<ScheduleRecord> = {}): ScheduleRecord => ({
  key: 'monthly',
  group: 'billing',
  job: identity,
  queue: identity.queue,
  cron: undefined,
  everyMs: 1_000,
  timeZone: 'UTC',
  payload: { month: 'current' },
  metadata: { source: 'postgres-test' },
  priority: 4,
  attemptsMax: 3,
  backoff: undefined,
  timeoutMs: 10_000,
  misfire: { strategy: 'run-once' },
  overlap: 'allow',
  paused: false,
  revision: 0,
  nextRunAtMs: 1_000,
  lastScheduledAtMs: undefined,
  lastJobId: undefined,
  createdAtMs: 0,
  updatedAtMs: 0,
  ...overrides
})

const tick = (overrides: Partial<TickScheduleCommand> = {}): TickScheduleCommand => ({
  key: 'monthly',
  expectedRevision: 0,
  expectedRunAtMs: 1_000,
  nowMs: 1_001,
  decision: {
    occurrences: [1_000],
    nextRunAtMs: 2_000
  },
  ...overrides
})

test('PostgresJobScheduleStore persists CRUD and atomically fires deterministic jobs', async () => {
  const { database, pool } = await makePool()
  const schema = 'mq_schedule_test'
  const client = PostgresClient.fromPool({ pool, schema })
  await client.migrate({ appliedAtMs: 1 })
  const runtime = await Runtime.make(
    Layer.merge(
      PostgresJobStore.layer({ pool, schema, validateSchema: false }),
      PostgresJobScheduleStore.layer({ pool, schema, validateSchema: false })
    )
  )

  try {
    const schedules = await runtime.run(() => ServiceRuntime.resolve(JobScheduleStore))
    const jobs = await runtime.run(() => ServiceRuntime.resolve(JobStore))
    const first = await resolve(schedules.upsertSchedule(record()))

    expect(first).toMatchObject({ created: true, changed: true })
    expect(
      (await resolve(schedules.dueSchedules({ nowMs: 1_000 }))).map((item) => item.key)
    ).toEqual(['monthly'])

    const fired = await resolve(schedules.tickSchedule(tick()))
    const expectedId = makeJobId('sched/monthly/1000').unwrap()
    expect(fired.status).toBe('fired')
    expect(fired.jobs.map((job) => job.id)).toEqual([expectedId])
    expect(fired.schedule.revision).toBe(1)
    expect((await resolve(jobs.getJob({ jobId: expectedId })))?.id).toBe(expectedId)
    expect((await resolve(jobs.counts())).total).toBe(1)

    // SAFETY: this query selects one known numeric column from the test schema.
    const wake = (await database.query(
      `SELECT wake_version FROM "${schema}".better_effect_mq_queues WHERE namespace=$1 AND queue=$2`,
      ['default', 'billing']
    )) as { readonly rows: readonly { readonly wake_version: number }[] }
    expect(wake.rows[0]?.wake_version).toBe(1)

    const stale = await resolve(schedules.tickSchedule(tick()))
    expect(stale.status).toBe('stale')
    expect((await resolve(jobs.counts())).total).toBe(1)

    await resolve(schedules.pauseSchedule('monthly'))
    expect((await resolve(schedules.dueSchedules({ nowMs: 10_000 }))).length).toBe(0)
    await resolve(schedules.resumeSchedule('monthly'))
    expect((await resolve(schedules.getSchedule('monthly')))?.paused).toBe(false)

    expect(
      (await resolve(schedules.listSchedules({ group: 'billing' }))).map((item) => item.key)
    ).toEqual(['monthly'])
    expect(await resolve(schedules.removeSchedule('monthly'))).toBe(true)
    expect(await resolve(schedules.getSchedule('monthly'))).toBeUndefined()
  } finally {
    await runtime.dispose()
    await database.close()
  }
})

test('PostgresJobScheduleStore applies overlap skip inside the same transaction', async () => {
  const { database, pool } = await makePool()
  const schema = 'mq_schedule_overlap_test'
  const client = PostgresClient.fromPool({ pool, schema })
  await client.migrate({ appliedAtMs: 1 })
  const runtime = await Runtime.make(
    Layer.merge(
      PostgresJobStore.layer({ pool, schema, validateSchema: false }),
      PostgresJobScheduleStore.layer({ pool, schema, validateSchema: false })
    )
  )

  try {
    const schedules = await runtime.run(() => ServiceRuntime.resolve(JobScheduleStore))
    const skippedRecord = record({ key: 'skip', overlap: 'skip' })
    await resolve(schedules.upsertSchedule(skippedRecord))
    const first = await resolve(
      schedules.tickSchedule(
        tick({ key: 'skip', decision: { occurrences: [1_000], nextRunAtMs: 2_000 } })
      )
    )
    const second = await resolve(
      schedules.tickSchedule(
        tick({
          key: 'skip',
          expectedRevision: 1,
          expectedRunAtMs: 2_000,
          nowMs: 2_001,
          decision: { occurrences: [2_000], nextRunAtMs: 3_000 }
        })
      )
    )

    expect(first.status).toBe('fired')
    expect(second.status).toBe('skipped')
    expect(second.jobs).toHaveLength(0)
    expect(second.skippedSlots).toEqual([2_000])
    expect(second.schedule.nextRunAtMs).toBe(3_000)
  } finally {
    await runtime.dispose()
    await database.close()
  }
})

test('PostgresJobScheduleStore.layerFor preserves named JobStore isolation', async () => {
  const { database, pool } = await makePool()
  const schema = 'mq_schedule_named_test'
  const client = PostgresClient.fromPool({ pool, schema })
  await client.migrate({ appliedAtMs: 1 })
  const Durable = JobStore.named('durable')
  const DurableSchedules = JobScheduleStore.for(Durable)
  const runtime = await Runtime.make(
    Layer.merge(
      PostgresJobStore.layerFor(Durable, { pool, schema, validateSchema: false }),
      PostgresJobScheduleStore.layerFor(DurableSchedules, {
        pool,
        schema,
        validateSchema: false
      })
    )
  )

  try {
    const schedules = await runtime.run(() => ServiceRuntime.resolve(DurableSchedules))
    await resolve(schedules.upsertSchedule(record({ key: 'named' })))
    expect((await resolve(schedules.listSchedules({}))).map((item) => item.key)).toEqual(['named'])
    // SAFETY: this query selects one known text aggregate from the test schema.
    const count = (await database.query(
      `SELECT count(*)::text AS count FROM "${schema}".better_effect_mq_schedules`
    )) as { readonly rows: readonly { readonly count: string }[] }
    expect(count.rows[0]?.count).toBe('1')
  } finally {
    await runtime.dispose()
    await database.close()
  }
})
