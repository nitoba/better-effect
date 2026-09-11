import { Effect, Service } from 'better-effect'
import { Result } from 'better-result'
import { Codec, Flow, JobContext, Queue } from '../src'
import type { WorkerFlowRequirements } from '../src/worker/types'

class BusinessService extends Service<BusinessService>()('FlowContextBusinessService') {
  readonly prefix!: string
}

const queue = Queue.define('flow-context-types')
const parent = queue.job('parent', { version: 1, payload: Codec.string, result: Codec.string })
const child = queue.job('child', { version: 1, payload: Codec.string, result: Codec.string })
const definition = Flow.define('flow-context-types', { parent, children: [child] as const })
const handler = Flow.handle(definition, {
  fanOut: (payload) =>
    Effect.fn(async function* () {
      const business = yield* BusinessService
      const context = yield* JobContext
      return Result.ok([
        Flow.children(child, [{ key: context.jobId, payload: business.prefix + payload }])
      ] as const)
    }),
  collect: (payload) =>
    Effect.fn(async function* () {
      const business = yield* BusinessService
      yield* JobContext
      return Result.ok(business.prefix + payload)
    })
})

type Requirements = WorkerFlowRequirements<readonly [typeof handler]>
type Assert<Condition extends true> = Condition
export type ContextIsProvidedPerAttempt = Assert<
  Extract<Requirements, JobContext> extends never ? true : false
>
export type BusinessDependencyMustStillBeProvided = Assert<
  BusinessService extends Requirements ? true : false
>
