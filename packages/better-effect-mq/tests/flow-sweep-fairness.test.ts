import { expect, test } from 'bun:test'
import { Effect, Layer, Runtime } from 'better-effect'
import { Result } from 'better-result'
import {
  Codec,
  Flow,
  FlowStore,
  JobId,
  JobStore,
  LeaseToken,
  MemoryFlowStore,
  MemoryJobStore,
  Queue,
  Worker,
  makeFlowChildId,
  makePreparedEnqueue
} from '../src'

async function unwrap<Value, Failure>(
  operation: Result<Value, Failure> | PromiseLike<Result<Value, Failure>>
): Promise<Value> {
  const result = await operation
  if (Result.isError(result)) throw result.error
  return result.value
}

test('bounded flow sweeps eventually visit every known parent without relying on report delivery', async () => {
  const jobs = MemoryJobStore.make()
  const flows = MemoryFlowStore.make()
  const queue = Queue.define('flow-sweep-fairness')
  const parent = queue.job('parent', { version: 1, payload: Codec.string, result: Codec.string })
  const child = queue.job('child', { version: 1, payload: Codec.string, result: Codec.string })
  const definition = Flow.define('flow-sweep-fairness', {
    parent,
    children: [child] as const,
    onChildFailure: 'continue'
  })
  const ids = ['first', 'second', 'third', 'fourth'].map((id) => JobId.make(`sweep-${id}`).unwrap())
  for (const flowId of ids) {
    const childJobId = makeFlowChildId({
      parentStoreKey: JobStore.serviceTag,
      flowId,
      childKey: 'one'
    }).unwrap()
    await unwrap(
      flows.fanOut({
        flowId,
        flowName: definition.name,
        parentStoreKey: JobStore.serviceTag,
        depth: 1,
        leaseToken: LeaseToken.make('independent-manifest').unwrap(),
        failFast: false,
        now: 0,
        children: [
          {
            childKey: 'one',
            name: child.name,
            version: child.version,
            storeKey: JobStore.serviceTag,
            childJobId,
            request: makePreparedEnqueue({
              protocolVersion: 1,
              identity: child.identity,
              id: childJobId,
              payload: flowId,
              metadata: {},
              priority: 0,
              runAt: 0,
              now: 0,
              attemptsMax: 1
            }).unwrap()
          }
        ]
      })
    )
  }
  // Recovery manifests deliberately have no report metadata. This exercises the
  // authoritative job observation path, not the faster best-effort report path.
  const token = Worker.service('FairFlowSweeper')
  const live = Layer.complete(
    Layer.merge(
      Layer.succeed(JobStore, JobStore.of(jobs)),
      Layer.succeed(FlowStore, FlowStore.of(flows)),
      token.layer(() => ({
        handlers: [
          Worker.handle(child, (value) =>
            Effect.fn(async function* () {
              yield* Result.ok(undefined)
              return Result.ok(value)
            })
          )
        ] as const,
        flows: [definition] as const,
        flowSweepFlowIds: ids,
        flowBatchSize: 2,
        flowSweepIntervalMs: 5,
        pollIntervalMs: 2
      }))
    )
  )
  await using runtime = await Runtime.make(live)
  await runtime.warmup()
  const until = Date.now() + 1_000
  let remaining = ids.length
  while (Date.now() < until) {
    remaining = 0
    for (const flowId of ids) {
      const value = await unwrap(flows.getFlow({ flowId }))
      if (value?.parent.flow.pending !== 0) remaining += 1
    }
    if (remaining === 0) break
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
  expect(remaining).toBe(0)
  // Earlier parents remain child-ready, not erased merely to let the last one run.
  for (const flowId of ids) {
    expect((await unwrap(flows.getFlow({ flowId })))?.parent.state).toBe('waiting')
  }
})
