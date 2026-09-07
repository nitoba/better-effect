import { expectTypeOf } from 'bun:test'
import { Layer } from 'better-effect'
import { JobEventStore, JobStore } from 'better-effect-mq'
import { MYSQL_TABLES, MySqlJobEventStore, type Pool } from '../../src'

const pool: Pool = {
  getConnection: async () => {
    throw new Error('type-only pool')
  }
}
const defaultLayer = MySqlJobEventStore.layer({ pool, validateSchema: false })
const named = JobStore.named('events-types')
const namedEvents = JobEventStore.for(named)
const namedLayer = MySqlJobEventStore.layerFor(namedEvents, { pool, validateSchema: false })

expectTypeOf(MYSQL_TABLES.events).toEqualTypeOf<'better_effect_mq_job_events'>()
expectTypeOf(MYSQL_TABLES.eventCursors).toEqualTypeOf<'better_effect_mq_job_event_cursors'>()
expectTypeOf(defaultLayer).toMatchTypeOf<Layer<JobEventStore, never>>()
expectTypeOf(namedLayer).toMatchTypeOf<Layer<JobEventStore.Instance<typeof named>, never>>()
expectTypeOf(MySqlJobEventStore.layerFromConfig).toBeFunction()

void defaultLayer
void namedLayer
