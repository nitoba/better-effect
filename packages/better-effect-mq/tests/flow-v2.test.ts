import { expect, test } from 'bun:test'
import { Result, type Result as ResultType } from 'better-result'

import {
  Codec,
  Flow,
  JobDefinitionError,
  JobId,
  makeFlowChildId,
  makePreparedEnqueue,
  protocolVersion,
  protocolVersionV2,
  validateFlowChildSpec,
  validateFlowManifest,
  validateParentEnvelope,
  Queue
} from '../src'
import type { FlowChildSpec, ParentEnvelope } from '../src'

const unwrap = <Value, Failure>(result: ResultType<Value, Failure>): Value => {
  if (Result.isError(result)) throw result.error
  return result.value
}

const flowId = unwrap(JobId.make('parent-1'))

const makeSpec = (
  childKey: string,
  id = makeFlowChildId({
    parentStoreKey: 'parent-store',
    flowId,
    childKey
  }).unwrap()
): FlowChildSpec => {
  const request = unwrap(
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
})

test('flow child IDs use an unambiguous, versioned encoding', () => {
  const first = unwrap(makeFlowChildId({ parentStoreKey: 'ab', flowId, childKey: 'c' }))
  const second = unwrap(makeFlowChildId({ parentStoreKey: 'a', flowId, childKey: 'bc' }))

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
    childJobId: unwrap(JobId.make('different-id'))
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
    { key: 'user:1', payload: { userId: '1' }, options: { attempts: 2 } }
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

void Parent
void Child
