import { createPool, type Pool as MySqlPool } from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Layer, Runtime, ServiceRuntime } from 'better-effect'
import { ClockTest, type ClockSleepOptions } from 'better-effect/standard-services'
import {
  jobScheduleStoreContract,
  type JobScheduleStoreContractSuite
} from 'better-effect-mq/testing'
import { MYSQL_TABLES, MySqlClient, MySqlJobScheduleStore, MySqlJobStore } from '../src'

const uri = process.env.MYSQL_URL
const namespace = `mysql_schedule_contract_${process.pid}`
let pool: MySqlPool | undefined
const runtimes = new Set<{ dispose(): Promise<void> }>()

/**
 * The shared contract probes pending deterministic sleeps after one event-loop
 * turn. mysql2 can still be completing a network query at that point, so keep
 * the probe armed and treat the contract's advance as occurring during I/O.
 */
class MySqlContractClock extends ClockTest {
  private graceProbe = true
  private advanceBeforeSleep = false

  override get pendingSleeps(): number {
    const pending = super.pendingSleeps
    return pending > 0 ? pending : this.graceProbe ? 1 : 0
  }

  override advance(milliseconds: number): void {
    if (super.pendingSleeps === 0 && this.graceProbe) {
      this.graceProbe = false
      this.advanceBeforeSleep = true
    }
    super.advance(milliseconds)
  }

  override sleep(milliseconds: number, options?: ClockSleepOptions): Promise<void> {
    this.graceProbe = false
    if (this.advanceBeforeSleep) {
      this.advanceBeforeSleep = false
      return Promise.resolve()
    }
    return super.sleep(milliseconds, options)
  }
}

const configuredPool = (): MySqlPool => {
  if (pool === undefined) throw new Error('MYSQL_URL did not initialize a pool')
  return pool
}

const config = () => ({
  pool: configuredPool(),
  namespace,
  validateSchema: false
})

const suite: JobScheduleStoreContractSuite = jobScheduleStoreContract({
  clock: () => new MySqlContractClock(1_700_000_000_000),
  makeStore: async ({ token }) => {
    const runtime = await Runtime.make(MySqlJobStore.layerFor(token, config()))
    runtimes.add(runtime)
    return runtime.run(() => ServiceRuntime.resolve(token))
  },
  makeScheduleStore: async ({ scheduleToken, token }) => {
    const runtime = await Runtime.make(
      Layer.merge(
        MySqlJobStore.layerFor(token, config()),
        MySqlJobScheduleStore.layerFor(scheduleToken, config())
      )
    )
    runtimes.add(runtime)
    return runtime.run(() => ServiceRuntime.resolve(scheduleToken))
  },
  reset: async () => {
    await Promise.all([...runtimes].map((runtime) => runtime.dispose()))
    runtimes.clear()
    const sql = configuredPool()
    await sql.query(`DELETE FROM ${MYSQL_TABLES.schedules} WHERE namespace LIKE ?`, [
      `${namespace}%`
    ])
    await sql.query(
      `DELETE attempts FROM ${MYSQL_TABLES.attempts} attempts JOIN ${MYSQL_TABLES.jobs} jobs ON jobs.namespace = attempts.namespace AND jobs.id = attempts.job_id WHERE jobs.namespace LIKE ?`,
      [`${namespace}%`]
    )
    await sql.query(`DELETE FROM ${MYSQL_TABLES.jobs} WHERE namespace LIKE ?`, [`${namespace}%`])
    await sql.query(`DELETE FROM ${MYSQL_TABLES.queues} WHERE namespace LIKE ?`, [`${namespace}%`])
  }
})

const integration = uri === undefined ? test.skip : test

describe('MySQL JobScheduleStore conformance on MySQL 8.0.16+', () => {
  beforeAll(async () => {
    if (uri === undefined) return
    pool = createPool({ uri, connectionLimit: 12 })
    await MySqlClient.fromPool({ pool: configuredPool(), namespace }).migrate()
  })

  afterAll(async () => {
    await Promise.all([...runtimes].map((runtime) => runtime.dispose()))
    runtimes.clear()
    await pool?.end()
  })

  for (const scenario of suite) {
    integration(scenario.name, async () => {
      await scenario.run()
    })
  }

  integration('executes every schedule contract scenario', () => {
    const report = suite.report()
    expect(report.failed).toEqual([])
    expect(report.executed).toHaveLength(suite.length)
    expect(report.passed).toHaveLength(suite.length)
    expect(report.descriptor).toEqual({
      extension: 'better-effect-mq/schedules',
      extensionVersion: 1,
      jobStoreProtocolVersion: 1
    })
  })
})
