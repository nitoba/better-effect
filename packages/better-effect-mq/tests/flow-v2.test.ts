import { expect, test } from 'bun:test'
import { Result, type Result as ResultType } from 'better-result'

import {
  Codec,
  Flow,
  JobDefinitionError,
  JobId,
  LeaseToken,
  MemoryFlowStore,
  makeFlowChildId,
  makePreparedEnqueue,
  makeSerializedJobFailure,
  protocolVersion,
  protocolVersionV2,
  Retry,
  validateFlowChildSpec,
  validateFlowManifest,
  validateFlowMigration,
  validateParentEnvelope,
  Queue
} from '../src'
import type { FlowChildSpec } from '../src'

const unwrapResult = <Value, Failure>(result: ResultType<Value, Failure>): Value => {
  if (Result.isError(result)) throw result.error
  return result.value
}

const unwrap = async <Value, Failure>(
  result: ResultType<Value, Failure> | PromiseLike<ResultType<Value, Failure>>
): Promise<Value> => unwrapResult(await result)

const flowId = unwrapResult(JobId.make('parent-1'))

const makeSpec = (
  childKey: string,
  id = makeFlowChildId({
    parentStoreKey: 'parent-store',
    flowId,
    childKey
  }).unwrap()
): FlowChildSpec => {
  const request = unwrapResult(
    makePreparedEnqueue({
      protocolVersion,
      identity: { queue: 'notifications', name: 'send-email', version: 1 },
      id,
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
    name: 'send-email',
    version: 1,
    storeKey: 'child-store',
    childJobId: id,
    request
  }
}

test('flow protocol v2 has an explicit version and accepts waiting-children only in v2', () => {
  expect(protocolVersion).toBe(1)
  expect(protocolVersionV2).toBe(2)
  expect(
    validateParentEnvelope({
      flowName: 'daily-digest',
      flowId,
      childKey: 'email:1',
      parentStoreKey: 'parent-store',
      depth: 1
    }).isOk()
  ).toBe(true)
  expect(
    validateParentEnvelope({
      flowName: 'daily-digest',
      flowId,
      childKey: 'email:1',
      parentStoreKey: 'parent-store',
      depth: 0
    }).isOk()
  ).toBe(false)
  expect(
    validateParentEnvelope({
      flowName: 'daily-digest',
      flowId,
      childKey: 'email:1',
      parentStoreKey: 'parent-store',
      depth: 33
    }).isErr()
  ).toBe(true)
  expect(validateFlowMigration({ status: 'required', from: 1, to: 2 }).isOk()).toBe(true)
  expect(validateFlowMigration({ status: 'unknown', from: 1, to: 2 }).isErr()).toBe(true)
})

test('flow child IDs use an unambiguous, versioned encoding', () => {
  const first = unwrapResult(makeFlowChildId({ parentStoreKey: 'ab', flowId, childKey: 'c' }))
  const second = unwrapResult(makeFlowChildId({ parentStoreKey: 'a', flowId, childKey: 'bc' }))

  expect(first).not.toBe(second)
  expect(first.startsWith('flow-v2/')).toBe(true)
})

test('manifest validation rejects duplicate child keys before persistence', () => {
  const duplicate = validateFlowManifest([makeSpec('same'), makeSpec('same')])

  expect(Result.isError(duplicate)).toBe(true)
  if (Result.isError(duplicate)) {
    expect(JobDefinitionError.is(duplicate.error)).toBe(true)
    expect(duplicate.error.field).toBe('children')
  }
})

test('flow child specs require the deterministic job ID in their prepared request', () => {
  const invalid: FlowChildSpec = {
    ...makeSpec('email:1'),
    childJobId: unwrapResult(JobId.make('different-id'))
  }

  expect(validateFlowChildSpec(invalid).isErr()).toBe(true)
})

const flowQueue = Queue.define('flow-tests')
const Parent = flowQueue.job('parent', {
  version: 1,
  payload: Codec.json<{ readonly day: string }>()
})
const Child = flowQueue.job('child', {
  version: 1,
  payload: Codec.json<{ readonly userId: string }>()
})

test('Flow.define and Flow.children create inert immutable descriptors', () => {
  const flow = Flow.define('daily-digest', {
    parent: Parent,
    children: [Child],
    onChildFailure: 'continue'
  })
  const children = Flow.children(Child, [
    {
      key: 'user:1',
      payload: { userId: '1' },
      options: { attempts: 2, backoff: Retry.fixed({ delayMs: 100 }) }
    }
  ])

  expect(Flow.is(flow)).toBe(true)
  expect(Object.isFrozen(flow)).toBe(true)
  expect(Object.isFrozen(children)).toBe(true)
  expect(Object.isFrozen(children.items)).toBe(true)
  expect(flow.maxChildren).toBe(10_000)
  expect(flow.maxDepth).toBe(8)
  expect(children.job).toBe(Child)
  expect(children.items[0]?.key).toBe('user:1')
})

test('Flow.define and Flow.children reject invalid identities and child keys', () => {
  expect(() =>
    Flow.define('duplicate-flow', {
      parent: Parent,
      children: [Child, Child],
      onChildFailure: 'fail'
    })
  ).toThrow(JobDefinitionError)

  expect(() => Flow.children(Child, [{ key: '', payload: { userId: '1' } }])).toThrow(
    JobDefinitionError
  )
  expect(() =>
    Flow.children(Child, [
      { key: 'same', payload: { userId: '1' } },
      { key: 'same', payload: { userId: '2' } }
    ])
  ).toThrow(JobDefinitionError)
})

test('Flow.is safely rejects hostile descriptor-like values', () => {
  const hostile = new Proxy(
    {},
    {
      has: () => {
        throw new Error('hostile has trap')
      }
    }
  )

  expect(Flow.is(hostile)).toBe(false)
})

const fanOutRequest = (
  overrides: Partial<Parameters<ReturnType<typeof MemoryFlowStore.make>['fanOut']>[0]> = {}
) => ({
  flowId,
  flowName: 'daily-digest',
  parentStoreKey: 'parent-store',
  depth: 1,
  leaseToken: LeaseToken.make('parent-lease').unwrap(),
  failFast: false,
  children: [makeSpec('email:1'), makeSpec('email:2')],
  now: 0,
  ...overrides
})

test('MemoryFlowStore applies FanOut atomically and acknowledges an identical replay', async () => {
  const store = MemoryFlowStore.make()
  const first = await unwrap(store.fanOut(fanOutRequest()))

  expect(first.status).toBe('applied')
  expect(first.parent.state).toBe('waiting-children')
  expect(first.parent.flow).toMatchObject({ pending: 2, completed: 0, failed: 0, cancelled: 0 })
  expect(first.children.map((child) => child.status)).toEqual(['pending', 'pending'])

  const replay = await unwrap(store.fanOut(fanOutRequest()))
  expect(replay.status).toBe('already-applied')
  expect((await unwrap(store.getFlow({ flowId })))?.children).toHaveLength(2)

  const conflict = await store.fanOut(fanOutRequest({ children: [makeSpec('different')] }))
  expect(Result.isError(conflict)).toBe(true)
})

test('MemoryFlowStore rejects the complete manifest before creating any flow rows', async () => {
  const store = MemoryFlowStore.make()
  const rejected = await store.fanOut(fanOutRequest({ maxChildren: 1 }))

  expect(Result.isError(rejected)).toBe(true)
  expect(await unwrap(store.getFlow({ flowId }))).toBeUndefined()
})

test('MemoryFlowStore sends an empty manifest directly to collect-ready waiting', async () => {
  const result = await unwrap(MemoryFlowStore.make().fanOut(fanOutRequest({ children: [] })))

  expect(result.parent.state).toBe('waiting')
  expect(result.parent.flow.pending).toBe(0)
  expect(result.children).toEqual([])
})

test('MemoryFlowStore records continue reports idempotently and becomes collect-ready', async () => {
  const store = MemoryFlowStore.make()
  await unwrap(store.fanOut(fanOutRequest()))
  const failure = unwrapResult(
    makeSerializedJobFailure({ kind: 'typed', message: 'blocked', retryable: false, recordedAt: 1 })
  )

  const failed = await unwrap(
    store.recordChildResults({
      flowId,
      now: 1,
      reports: [{ flowId, childKey: 'email:1', outcome: 'failed', result: undefined, failure }]
    })
  )
  expect(failed.applied).toBe(1)
  expect(failed.parentSettled).toBe(false)
  expect(failed.parent.flow).toMatchObject({ pending: 1, failed: 1 })

  const duplicate = await unwrap(
    store.recordChildResults({
      flowId,
      now: 2,
      reports: [{ flowId, childKey: 'email:1', outcome: 'failed', result: undefined, failure }]
    })
  )
  expect(duplicate.applied).toBe(0)

  const completed = await unwrap(
    store.recordChildResults({
      flowId,
      now: 3,
      reports: [
        {
          flowId,
          childKey: 'email:2',
          outcome: 'completed',
          result: { delivered: true },
          failure: undefined
        }
      ]
    })
  )
  expect(completed.applied).toBe(1)
  expect(completed.parentSettled).toBe(true)
  expect(completed.parent.state).toBe('waiting')
  expect(completed.parent.flow).toMatchObject({ pending: 0, completed: 1, failed: 1 })
})

test('MemoryFlowStore fail-fast wins and marks remaining children for cascade', async () => {
  const store = MemoryFlowStore.make()
  await unwrap(store.fanOut(fanOutRequest({ failFast: true })))
  const failure = unwrapResult(
    makeSerializedJobFailure({
      kind: 'typed',
      message: 'failed child',
      retryable: false,
      recordedAt: 1
    })
  )

  const settled = await unwrap(
    store.recordChildResults({
      flowId,
      now: 1,
      reports: [{ flowId, childKey: 'email:1', outcome: 'failed', result: undefined, failure }]
    })
  )
  expect(settled.parentSettled).toBe(true)
  expect(settled.parent.state).toBe('failed')
  expect(settled.parent.flow).toMatchObject({ pending: 0, failed: 1, cancelled: 1 })
  expect(settled.children.find((child) => child.childKey === 'email:2')).toMatchObject({
    status: 'cancelled',
    cascaded: false
  })

  const late = await unwrap(
    store.recordChildResults({
      flowId,
      now: 2,
      reports: [
        {
          flowId,
          childKey: 'email:2',
          outcome: 'completed',
          result: { late: true },
          failure: undefined
        }
      ]
    })
  )
  expect(late.applied).toBe(0)
})

test('MemoryFlowStore cancellation and cascade acknowledgement are idempotent', async () => {
  const store = MemoryFlowStore.make()
  await unwrap(store.fanOut(fanOutRequest()))

  const cancelled = await unwrap(store.cancel({ flowId, now: 1 }))
  expect(cancelled.parentSettled).toBe(true)
  expect(cancelled.parent.state).toBe('cancelled')
  expect(cancelled.cancelled).toBe(2)
  expect(cancelled.children.every((child) => child.status === 'cancelled' && !child.cascaded)).toBe(
    true
  )

  const acknowledged = await unwrap(store.markCascaded({ flowId, childKeys: ['email:1'] }))
  expect(acknowledged.marked).toBe(1)
  expect(acknowledged.children.find((child) => child.childKey === 'email:1')?.cascaded).toBe(true)
  expect((await unwrap(store.markCascaded({ flowId, childKeys: ['email:1'] }))).marked).toBe(0)
})

test('MemoryFlowStore reconciliation returns deterministic enqueue, terminal reports, and cascade work', async () => {
  const store = MemoryFlowStore.make()
  await unwrap(store.fanOut(fanOutRequest()))
  const reconciliation = await unwrap(
    store.reconcile({
      flowId,
      now: 10,
      observations: [
        { childKey: 'email:1', state: 'missing' },
        { childKey: 'email:2', state: 'completed', result: { sent: true } }
      ]
    })
  )

  expect(reconciliation.enqueue.map((child) => child.childKey)).toEqual(['email:1'])
  expect(reconciliation.reports).toEqual([
    {
      flowId,
      childKey: 'email:2',
      outcome: 'completed',
      result: { sent: true },
      failure: undefined
    }
  ])
  expect(reconciliation.cascade).toEqual([])
  expect((await unwrap(store.getFlow({ flowId })))?.children[0]?.pendingSinceMs).toBe(10)
})

void Parent
void Child
