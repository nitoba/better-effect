import { expectTypeOf } from 'bun:test'

import { Layer } from 'better-effect'
import {
  DashboardAuditSink,
  DashboardAuditSinkDisabled,
  DashboardJobRedactionPolicy,
  DashboardJobRedactionPolicyDisabled,
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

const redactionLayer = Layer.succeed(
  DashboardJobRedactionPolicy,
  DashboardJobRedactionPolicy.of({
    available: true,
    decide: async ({ action, job, principal, request, target }) => {
      expectTypeOf(job.id).toEqualTypeOf<string>()
      expectTypeOf(job.queue).toEqualTypeOf<string>()
      expectTypeOf(job.name).toEqualTypeOf<string>()
      expectTypeOf(job.version).toEqualTypeOf<number>()
      expectTypeOf(principal.role).toEqualTypeOf<'viewer' | 'operator' | 'admin'>()
      expectTypeOf(request).toEqualTypeOf<Request>()
      expectTypeOf(target).toEqualTypeOf<'list' | 'detail' | 'attempts' | 'mutation'>()
      expectTypeOf(action).toEqualTypeOf<
        | undefined
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
      return {
        allowed: true as const,
        payload: false,
        result: false,
        failure: false,
        metadataKeys: []
      }
    }
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
expectTypeOf<Layer.Provided<typeof redactionLayer>>().toEqualTypeOf<
  InstanceType<typeof DashboardJobRedactionPolicy>
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
expectTypeOf<Layer.Provided<typeof DashboardJobRedactionPolicyDisabled>>().toEqualTypeOf<
  InstanceType<typeof DashboardJobRedactionPolicy>
>()

void policyLayer
void auditLayer
void limiterLayer
void redactionLayer
