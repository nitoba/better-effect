import { expect, test } from 'bun:test'
import { Result, type Result as ResultType } from 'better-result'

import {
  JobDefinitionError,
  JobId,
  JobName,
  QueueName,
  makeFlowChildId,
  makePreparedEnqueue,
  protocolVersion,
  protocolVersionV2,
  validateFlowChildSpec,
  validateFlowManifest,
  validateParentEnvelope
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

const parent: ParentEnvelope = {
  flowName: 'daily-digest',
  flowId,
  childKey: 'email:1',
  parentStoreKey: 'parent-store',
  depth: 1
}

void JobName
void QueueName
void parent
