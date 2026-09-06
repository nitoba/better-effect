import { expectTypeOf } from 'bun:test'

import type {
  FlowChildReport,
  FlowChildSpec,
  JobState,
  JobStateV2,
  ParentEnvelope,
  ProtocolVersion,
  ProtocolVersionV2,
  SettlementOutcome,
  SettlementOutcomeV2
} from '../../src'

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
