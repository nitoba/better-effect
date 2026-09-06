import { expect, test } from 'bun:test'
import { JobScheduleStore, JobStore } from 'better-effect-mq'
import { MYSQL_INDEXES, MYSQL_TABLES, MySqlJobScheduleStore, loadMySqlMigrations } from '../src'

test('MySQL schedules expose the associated-store adapter and migration layout', async () => {
  const migrations = await loadMySqlMigrations()
  expect(migrations.at(-1)?.version).toBe(3)
  expect(MYSQL_TABLES.schedules).toBe('better_effect_mq_schedules')
  expect(MYSQL_INDEXES).toContain('better_effect_mq_schedules_due_idx')

  const durable = JobStore.named('durable')
  const schedules = JobScheduleStore.for(durable)
  const layer = MySqlJobScheduleStore.layerFor(schedules, {
    pool: {
      getConnection: async () => {
        throw new Error('not acquired')
      }
    },
    validateSchema: false
  })

  expect(schedules.jobStore).toBe(durable)
  expect(layer).toBeDefined()
})
