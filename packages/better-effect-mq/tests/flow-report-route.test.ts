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

test('a terminal child reports through the FlowStore token rather than the JobStore token', async () => {
  const storeToken = JobStore.named('report-route-regression')
  const flowToken = FlowStore.for(storeToken)
  expect(flowToken.serviceTag).not.toBe(storeToken.serviceTag)
  const jobs = MemoryJobStore.make()
  const flows = MemoryFlowStore.make()
  const queue = Queue.define('report-route-regression')
  const parent = queue.job('parent', {
    version: 1,
    payload: Codec.string,
    result: Codec.string,
    store: storeToken
  })
  const child = queue.job('child', {
    version: 1,
    payload: Codec.string,
    result: Codec.string,
    store: storeToken
  })
  const definition = Flow.define('report-route-regression', {
    parent,
    children: [child] as const,
    onChildFailure: 'continue'
  })
  const flowId = JobId.make('parent-report-route').unwrap()
  const childJobId = makeFlowChildId({
    parentStoreKey: storeToken.serviceTag,
    flowId,
    childKey: 'one'
  }).unwrap()
  const request = makePreparedEnqueue({
    protocolVersion: 1,
    identity: child.identity,
    id: childJobId,
    payload: 'result',
    metadata: {
      '__better_effect_flow_v2.flowName': definition.name,
      '__better_effect_flow_v2.flowId': flowId,
      '__better_effect_flow_v2.childKey': 'one',
      '__better_effect_flow_v2.parentStoreKey': storeToken.serviceTag,
      '__better_effect_flow_v2.depth': '1',
      '__better_effect_flow_v2.chain': JSON.stringify([definition.name])
    },
    priority: 0,
    runAt: 0,
    now: 0,
    attemptsMax: 1
  }).unwrap()
  await unwrap(
    flows.fanOut({
      flowId,
      flowName: definition.name,
      parentStoreKey: storeToken.serviceTag,
      depth: 1,
      leaseToken: LeaseToken.make('independent-manifest').unwrap(),
      failFast: false,
      now: 0,
      children: [
        {
          childKey: 'one',
          name: child.name,
          version: child.version,
          storeKey: storeToken.serviceTag,
          childJobId,
          request
        }
      ]
    })
  )
  const { protocolVersion: _version, ...enqueue } = request
  await unwrap(jobs.enqueue(enqueue))
  const token = Worker.service('ReportRouteRegression')
  const live = Layer.complete(
    Layer.merge(
      Layer.succeed(storeToken, storeToken.of(jobs)),
      Layer.succeed(flowToken, flowToken.of(flows)),
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
        // No recovery ids: only the durable report path can discover this parent.
        flowSweepIntervalMs: 60_000,
        pollIntervalMs: 2
      }))
    )
  )
  await using runtime = await Runtime.make(live)
  await runtime.warmup()
  const deadline = Date.now() + 1_000
  let completed = false
  while (Date.now() < deadline) {
    const snapshot = await unwrap(flows.getFlow({ flowId }))
    completed = snapshot?.children[0]?.status === 'completed'
    if (completed) break
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
  expect((await unwrap(jobs.getJob({ jobId: childJobId })))?.state).toBe('completed')
  expect(completed).toBe(true)
  expect((await unwrap(flows.getFlow({ flowId })))?.parent.flow.pending).toBe(0)
})
