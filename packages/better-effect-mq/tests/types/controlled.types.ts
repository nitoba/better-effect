import { expectTypeOf } from 'bun:test'

import { Effect, Runtime } from 'better-effect'
import {
  Queue,
  QueueControls,
  type ControlsReconcileReport,
  type QueueControlsEffect
} from '../../src'

const Exports = Queue.define('type-exports')
const Controls = QueueControls.define(Exports, {
  globalConcurrency: 4,
  concurrencyKey: {
    derive: (payload: { readonly tenantId: string }) => payload.tenantId,
    max: 2
  },
  rateLimit: { max: 10, durationMs: 1_000 }
})
const Registry = QueueControls.registry({ group: 'types', controls: [Controls] })
const reconcile = QueueControls.reconcile(Registry)

expectTypeOf(Registry.controls[0]).toEqualTypeOf<typeof Controls>()
expectTypeOf(reconcile).toMatchTypeOf<QueueControlsEffect<ControlsReconcileReport>>()

void Effect
void Runtime
