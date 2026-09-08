import { expectTypeOf } from 'bun:test'

import { Layer } from 'better-effect'
import {
  DashboardAuditSink,
  DashboardAuditSinkDisabled,
  DashboardMutationPolicy,
  DashboardMutationPolicyDisabled,
  DashboardRateLimiter,
  DashboardRateLimiterDisabled
} from '../../src'

const policyLayer = Layer.succeed(
  DashboardMutationPolicy,
  DashboardMutationPolicy.of({
    available: true,
    check: async ({ action }) => {
      expectTypeOf(action).toEqualTypeOf<
        | 'job.cancel'
        | 'job.promote'
        | 'job.retry'
        | 'job.redrive'
        | 'job.remove'
        | 'queue.pause'
        | 'queue.resume'
        | 'schedule.pause'
        | 'schedule.resume'
        | 'schedule.remove'
        | 'flow.cancel'
      >()
      return { allowed: true as const }
    }
  })
)

const auditLayer = Layer.succeed(
  DashboardAuditSink,
  DashboardAuditSink.of({ available: true, record: async () => undefined })
)

const limiterLayer = Layer.succeed(
  DashboardRateLimiter,
  DashboardRateLimiter.of({
    available: true,
    check: async () => ({ allowed: true, retryAfterSeconds: undefined })
  })
)

expectTypeOf<Layer.Provided<typeof policyLayer>>().toEqualTypeOf<
  InstanceType<typeof DashboardMutationPolicy>
>()
expectTypeOf<Layer.Required<typeof policyLayer>>().toBeNever()
expectTypeOf<Layer.Provided<typeof auditLayer>>().toEqualTypeOf<
  InstanceType<typeof DashboardAuditSink>
>()
expectTypeOf<Layer.Provided<typeof limiterLayer>>().toEqualTypeOf<
  InstanceType<typeof DashboardRateLimiter>
>()
expectTypeOf<Layer.Provided<typeof DashboardMutationPolicyDisabled>>().toEqualTypeOf<
  InstanceType<typeof DashboardMutationPolicy>
>()
expectTypeOf<Layer.Provided<typeof DashboardAuditSinkDisabled>>().toEqualTypeOf<
  InstanceType<typeof DashboardAuditSink>
>()
expectTypeOf<Layer.Provided<typeof DashboardRateLimiterDisabled>>().toEqualTypeOf<
  InstanceType<typeof DashboardRateLimiter>
>()

void policyLayer
void auditLayer
void limiterLayer
