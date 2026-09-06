// Redis has no embedded test server, so this suite is skipped unless REDIS_URL is configured.

import { expect, test } from 'bun:test'
import { Result } from 'better-result'
import {
  JobId,
  LeaseToken,
  makeFlowChildId,
  makePreparedEnqueue,
  makeSerializedJobFailure,
  protocolVersion
} from 'better-effect-mq'
import { RedisClient, RedisFlowStore, type RedisJobStoreConnectionConfig } from '../src/index'
import type { FlowChildSpec, FlowStoreV2Operation } from 'better-effect-mq'

const url = process.env.REDIS_URL
const integration = url === undefined ? test.skip : test
const prefix = `better-effect-mq-flow-${process.pid}-${Date.now()}`

const unwrap = <Value, Failure>(result: Result<Value, Failure>): Value => {
  if (Result.isError(result)) throw result.error
  return result.value
}

const unwrapOperation = async <Value>(operation: FlowStoreV2Operation<Value>): Promise<Value> =>
  unwrap(await operation)

const config = (): RedisJobStoreConnectionConfig => {
  const value = { prefix, namespace: `flow-${Date.now()}`, validateLayout: true }
  return url === undefined ? value : { ...value, url }
}

const makeSpec = (flowId: JobId, childKey: string): FlowChildSpec => {
  const childJobId = unwrap(makeFlowChildId({ parentStoreKey: 'parent-store', flowId, childKey }))
  const request = unwrap(
    makePreparedEnqueue({
      protocolVersion,
      identity: { queue: 'flow', name: 'child', version: 1 },
      id: childJobId,
      payload: { childKey },
      metadata: {},
      priority: 0,
      runAt: 0,
      attemptsMax: 1,
      now: 0
    })
  )
  return {
    childKey,
    name: 'child',
    version: 1,
    storeKey: 'child-store',
    childJobId,
    request
  }
}

integration('executes the v2 atomic flow slice against Redis', async () => {
  const client = await RedisClient.fromConfig(config())
  try {
    const store = RedisFlowStore.make(client)
    const flowId = unwrap(JobId.make('redis-flow'))
    const leaseToken = unwrap(LeaseToken.make('parent-lease'))
    const first = await unwrapOperation(
      store.fanOut({
        flowId,
        flowName: 'redis-flow',
        parentStoreKey: 'parent-store',
        depth: 1,
        leaseToken,
        failFast: true,
        children: [makeSpec(flowId, 'one'), makeSpec(flowId, 'two')],
        now: 0
      })
    )
    expect(first.status).toBe('applied')
    expect(first.parent.state).toBe('waiting-children')

    expect(
      (
        await unwrapOperation(
          store.fanOut({
            flowId,
            flowName: 'redis-flow',
            parentStoreKey: 'parent-store',
            depth: 1,
            leaseToken,
            failFast: true,
            children: [makeSpec(flowId, 'one'), makeSpec(flowId, 'two')],
            now: 1
          })
        )
      ).status
    ).toBe('already-applied')

    const failure = unwrap(
      makeSerializedJobFailure({
        kind: 'typed',
        message: 'child failed',
        retryable: false,
        recordedAt: 2
      })
    )
    const settled = await unwrapOperation(
      store.recordChildResults({
        flowId,
        now: 2,
        reports: [{ flowId, childKey: 'one', outcome: 'failed', result: undefined, failure }]
      })
    )
    expect(settled.parent.state).toBe('failed')
    expect(settled.parent.flow).toMatchObject({ pending: 0, failed: 1, cancelled: 1 })

    const cascaded = await unwrapOperation(store.markCascaded({ flowId, childKeys: ['two'] }))
    expect(cascaded.marked).toBe(1)
    expect((await unwrapOperation(store.getFlow({ flowId })))?.children).toHaveLength(2)
  } finally {
    await client.dispose()
  }
})
