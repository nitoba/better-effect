import { expectTypeOf } from 'bun:test'
import type { ControlledJobStoreContract, QueueControlsRecord } from 'better-effect-mq'
import { MYSQL_TABLES, MySqlJobStore } from '../../src'

expectTypeOf(MYSQL_TABLES.controls).toEqualTypeOf<'better_effect_mq_queue_controls'>()
expectTypeOf(MYSQL_TABLES.controlCursors).toEqualTypeOf<'better_effect_mq_queue_control_cursors'>()
expectTypeOf(MYSQL_TABLES.permits).toEqualTypeOf<'better_effect_mq_controlled_permits'>()
expectTypeOf(MYSQL_TABLES.rateWindows).toEqualTypeOf<'better_effect_mq_rate_windows'>()
expectTypeOf<QueueControlsRecord['revision']>().toEqualTypeOf<number>()
expectTypeOf(MySqlJobStore.layer).toBeFunction()
expectTypeOf<ControlledJobStoreContract['claimControlled']>().toBeFunction()
