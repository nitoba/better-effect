import { expectTypeOf } from 'bun:test'
import { JobStore } from 'better-effect-mq'

import { OutboxRoutes } from '../../src'

const postgres = JobStore.named('postgres')
const redis = JobStore.named('redis')
const routes = OutboxRoutes.make({ postgres, redis })

expectTypeOf(routes.get('postgres')).toEqualTypeOf<typeof postgres | undefined>()
expectTypeOf(routes.get('redis')).toEqualTypeOf<typeof redis | undefined>()
expectTypeOf<(typeof routes.entries)[number]['store']>().toEqualTypeOf<
  typeof postgres | typeof redis
>()

const entries = OutboxRoutes.make([
  { target: 'postgres', store: postgres },
  { target: 'redis', store: redis }
] as const)
expectTypeOf(entries.get('postgres')).toEqualTypeOf<typeof postgres | undefined>()
