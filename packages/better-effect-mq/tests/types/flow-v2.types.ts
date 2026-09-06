import { expectTypeOf } from 'bun:test'

import { Codec, Flow, MemoryFlowStore, Queue } from '../../src'
import type {
  FlowChildReport,
  FlowChildSpec,
  FlowFanOutResult,
  FlowStoreV2,
  FlowStoreV2Operation,
  JobState,
  JobStateV2,
  ParentEnvelope,
  ProtocolVersion,
  ProtocolVersionV2,
  SettlementOutcome,
  SettlementOutcomeV2
} from '../../src'
declare const flowStore: FlowStoreV2
declare const fanOutResult: FlowStoreV2Operation<FlowFanOutResult>

expectTypeOf(flowStore.descriptor.protocolVersion).toEqualTypeOf<2>()
expectTypeOf(fanOutResult).toEqualTypeOf<FlowStoreV2Operation<FlowFanOutResult>>()
expectTypeOf(MemoryFlowStore.make()).toEqualTypeOf<FlowStoreV2>()

const queue = Queue.define('flow-types')
const parentJob = queue.job('parent', { version: 1, payload: Codec.json<{ day: string }>() })
const childJob = queue.job('child', { version: 1, payload: Codec.json<{ userId: string }>() })
const flow = Flow.define('daily-digest', {
  parent: parentJob,
  children: [childJob] as const,
  onChildFailure: 'continue'
})
const children = Flow.children(childJob, [{ key: 'user:1', payload: { userId: '1' } }])

expectTypeOf(flow.parent).toEqualTypeOf<typeof parentJob>()
expectTypeOf(flow.children).toEqualTypeOf<readonly [typeof childJob]>()
expectTypeOf(flow.onChildFailure).toEqualTypeOf<'continue'>()
expectTypeOf(children.job).toEqualTypeOf<typeof childJob>()
expectTypeOf(children.items[0]!.payload).toEqualTypeOf<{ userId: string }>()
// @ts-expect-error Flow.children must preserve the Job payload input type.
Flow.children(childJob, [{ key: 'invalid', payload: { wrong: true } }])

declare const v1: ProtocolVersion
declare const v2: ProtocolVersionV2
declare const state: JobState
declare const stateV2: JobStateV2
declare const spec: FlowChildSpec
declare const report: FlowChildReport
declare const outcome: SettlementOutcome
declare const outcomeV2: SettlementOutcomeV2
declare const parent: ParentEnvelope

expectTypeOf(v1).toEqualTypeOf<1>()
expectTypeOf(v2).toEqualTypeOf<2>()
expectTypeOf(state).toEqualTypeOf<JobState>()
expectTypeOf(stateV2).toEqualTypeOf<JobStateV2>()
expectTypeOf(outcome).toEqualTypeOf<SettlementOutcome>()
expectTypeOf(outcomeV2).toEqualTypeOf<SettlementOutcomeV2>()
expectTypeOf(spec.childKey).toEqualTypeOf<string>()
expectTypeOf(report.outcome).toEqualTypeOf<'completed' | 'failed' | 'cancelled'>()
expectTypeOf(parent.depth).toEqualTypeOf<number>()

const v1State: JobState = 'waiting'
// @ts-expect-error v1 state must not silently acquire waiting-children.
const invalidV1State: JobState = 'waiting-children'
const validV2State: JobStateV2 = 'waiting-children'

void v1State
void invalidV1State
void validV2State
