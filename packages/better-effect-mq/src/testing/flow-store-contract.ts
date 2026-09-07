import { Result } from 'better-result'

import {
  makeFlowChildId,
  makeJobId,
  makeLeaseToken,
  makePreparedEnqueue,
  makeSerializedJobFailure,
  protocolVersion,
  type FlowChildReport,
  type FlowChildSpec,
  type FlowOutboxEntry,
  type FlowStoreV2
} from '../index'
import type { FlowOutboxPage, FlowStoreV2Operation } from '../store'

export type FlowStoreContractMaybePromise<Value> = Value | PromiseLike<Value>

export interface FlowStoreContractScenarioInfo {
  readonly id: string
  readonly name: string
  readonly category: string
}

export interface FlowStoreContractScenario extends FlowStoreContractScenarioInfo {
  readonly run: () => Promise<void>
}

export interface FlowStoreContractOptions {
  readonly makeStore: (
    scenario: FlowStoreContractScenarioInfo
  ) => FlowStoreContractMaybePromise<FlowStoreV2>
  readonly dispose?: (
    store: FlowStoreV2,
    scenario: FlowStoreContractScenarioInfo
  ) => FlowStoreContractMaybePromise<void>
  readonly createFlow?: (
    store: FlowStoreV2,
    scenario: FlowStoreContractScenarioInfo,
    input: {
      readonly flowName: string
      readonly failFast: boolean
      readonly childKeys: readonly string[]
    }
  ) => FlowStoreContractMaybePromise<{
    readonly flowId: string
    readonly leaseToken: string
  }>
  readonly prefix?: string
}

export interface FlowStoreContractReport {
  readonly version: 1
  readonly executed: readonly string[]
  readonly passed: readonly string[]
  readonly failed: readonly string[]
}

export type FlowStoreContractSuite = readonly FlowStoreContractScenario[] & {
  readonly report: () => FlowStoreContractReport
}

export class FlowStoreConformanceError extends Error {
  readonly scenarioId: string
  readonly scenarioName: string
  readonly category: string
  readonly invariant: string

  constructor(scenario: FlowStoreContractScenarioInfo, invariant: string, detail: string) {
    super(`${scenario.id} (${scenario.name}) [${invariant}]: ${detail}`)
    this.name = 'FlowStoreConformanceError'
    this.scenarioId = scenario.id
    this.scenarioName = scenario.name
    this.category = scenario.category
    this.invariant = invariant
  }
}

const assert: (
  condition: boolean,
  scenario: FlowStoreContractScenarioInfo,
  invariant: string,
  detail: string
) => asserts condition = (condition, scenario, invariant, detail) => {
  if (!condition) throw new FlowStoreConformanceError(scenario, invariant, detail)
}

const unwrap = async <Value>(
  operation: FlowStoreV2Operation<Value>,
  scenario: FlowStoreContractScenarioInfo,
  invariant: string
): Promise<Value> => {
  const result = await operation
  if (Result.isError(result)) {
    throw new FlowStoreConformanceError(scenario, invariant, result.error.message)
  }
  return result.value
}

const childSpec = (flowId: string, childKey: string): FlowChildSpec => {
  const id = makeFlowChildId({
    parentStoreKey: 'contract-parent',
    flowId: makeJobId(flowId).unwrap(),
    childKey
  }).unwrap()
  return {
    childKey,
    name: 'contract-child',
    version: 1,
    storeKey: 'contract-child-store',
    childJobId: id,
    request: makePreparedEnqueue({
      protocolVersion,
      identity: { queue: 'contract', name: 'contract-child', version: 1 },
      id,
      payload: { childKey },
      metadata: {},
      priority: 0,
      runAt: 0,
      attemptsMax: 1,
      now: 0
    }).unwrap()
  }
}

const report = (
  flowId: string,
  childKey: string,
  outcome: FlowChildReport['outcome'],
  failure?: FlowChildReport['failure']
): FlowChildReport => ({
  flowId: makeJobId(flowId).unwrap(),
  childKey,
  outcome,
  result: outcome === 'completed' ? { childKey } : undefined,
  failure
})

const outboxEntry = (
  id: string,
  flowId: string,
  childKey: string,
  parentStoreKey: string,
  outcome: FlowChildReport['outcome'],
  failure?: FlowChildReport['failure']
): FlowOutboxEntry => ({
  id,
  flowName: 'contract-flow',
  parentStoreKey,
  report: report(flowId, childKey, outcome, failure)
})

const expectPage = (
  page: FlowOutboxPage,
  scenario: FlowStoreContractScenarioInfo,
  expectedIds: readonly string[],
  hasMore: boolean
): void => {
  assert(
    page.entries.map((entry) => entry.id).join('|') === expectedIds.join('|'),
    scenario,
    'outbox-order',
    `expected ${expectedIds.join(', ')}, received ${page.entries.map((entry) => entry.id).join(', ')}`
  )
  assert(page.hasMore === hasMore, scenario, 'outbox-page-bound', 'unexpected hasMore value')
}

const startFlow = async (
  options: FlowStoreContractOptions,
  store: FlowStoreV2,
  scenario: FlowStoreContractScenarioInfo,
  prefix: string,
  suffix: string,
  failFast: boolean,
  childKeys: readonly string[]
) => {
  const requestedFlowId = `flow-contract-${prefix}-${suffix}`
  const created =
    options.createFlow === undefined
      ? { flowId: requestedFlowId, leaseToken: `contract-${suffix}-lease` }
      : await options.createFlow(store, scenario, {
          flowName: 'contract-flow',
          failFast,
          childKeys
        })
  const flowId = makeJobId(created.flowId).unwrap()
  const leaseToken = makeLeaseToken(created.leaseToken).unwrap()
  await unwrap(
    store.fanOut({
      flowId,
      flowName: 'contract-flow',
      parentStoreKey: 'contract-parent',
      depth: 1,
      leaseToken,
      failFast,
      children: childKeys.map((childKey) => childSpec(flowId, childKey)),
      now: 0
    }),
    scenario,
    'fanout'
  )
  return flowId
}

const scenarios = (
  options: FlowStoreContractOptions,
  prefix: string
): readonly (FlowStoreContractScenarioInfo & {
  readonly body: (store: FlowStoreV2, scenario: FlowStoreContractScenarioInfo) => Promise<void>
})[] => [
  {
    id: 'descriptor',
    name: 'exposes the flow protocol descriptor',
    category: 'protocol',
    body: async (store, scenario) => {
      assert(store.descriptor.protocolVersion === 2, scenario, 'descriptor', 'protocol must be v2')
      assert(store.descriptor.layoutVersion !== '', scenario, 'descriptor', 'layout is required')
    }
  },
  {
    id: 'outbox-delivery',
    name: 'keeps terminal reports durable until exact acknowledgement',
    category: 'outbox',
    body: async (store, scenario) => {
      const flowId = `flow-contract-${prefix}-outbox`
      const failure = makeSerializedJobFailure({
        kind: 'typed',
        message: 'contract failure',
        retryable: false,
        recordedAt: 2
      }).unwrap()
      const entries = [
        outboxEntry('contract-outbox-1', flowId, 'one', 'known-parent', 'completed'),
        outboxEntry('contract-outbox-2', flowId, 'two', 'unknown-parent', 'failed', failure),
        outboxEntry('contract-outbox-3', flowId, 'three', 'known-parent', 'cancelled')
      ] as const
      const first = await unwrap(store.appendChildReport(entries[0]), scenario, 'outbox-append')
      assert(first.status === 'applied', scenario, 'outbox-append', 'first append must apply')
      const replay = await unwrap(
        store.appendChildReport(entries[0]),
        scenario,
        'outbox-idempotency'
      )
      assert(
        replay.status === 'already-applied',
        scenario,
        'outbox-idempotency',
        'replay must be already-applied'
      )
      await unwrap(store.appendChildReport(entries[1]), scenario, 'outbox-append')
      await unwrap(store.appendChildReport(entries[2]), scenario, 'outbox-append')

      const firstPage = await unwrap(store.peekOutbox({ limit: 2 }), scenario, 'outbox-peek')
      expectPage(firstPage, scenario, ['contract-outbox-1', 'contract-outbox-2'], true)
      const secondPage = await unwrap(
        store.peekOutbox({ cursor: firstPage.cursor, limit: 2 }),
        scenario,
        'outbox-cursor'
      )
      expectPage(secondPage, scenario, ['contract-outbox-3'], false)

      const routePage = await unwrap(
        store.peekOutbox({ parentStoreKey: 'known-parent', limit: 2 }),
        scenario,
        'outbox-route'
      )
      expectPage(routePage, scenario, ['contract-outbox-1', 'contract-outbox-3'], false)

      const mismatched = { ...entries[0], flowName: 'different-flow' }
      const skipped = await unwrap(
        store.ackOutbox({ entries: [mismatched] }),
        scenario,
        'outbox-ack-safety'
      )
      assert(
        skipped.acknowledged === 0 && skipped.skipped === 1,
        scenario,
        'outbox-ack-safety',
        'mismatched payload must remain'
      )

      const acknowledged = await unwrap(
        store.ackOutbox({ entries: [entries[0], entries[1]] }),
        scenario,
        'outbox-ack'
      )
      assert(
        acknowledged.acknowledged === 2,
        scenario,
        'outbox-ack',
        'confirmed entries must be removed'
      )
      const duplicateAck = await unwrap(
        store.ackOutbox({ entries: [entries[0], entries[1]] }),
        scenario,
        'outbox-ack-idempotency'
      )
      assert(
        duplicateAck.acknowledged === 0,
        scenario,
        'outbox-ack-idempotency',
        'ack replay must be harmless'
      )
      const remaining = await unwrap(store.peekOutbox({ limit: 10 }), scenario, 'outbox-peek')
      expectPage(remaining, scenario, ['contract-outbox-3'], false)
    }
  },
  {
    id: 'child-settlement',
    name: 'confirms child terminal reports idempotently',
    category: 'settlement',
    body: async (store, scenario) => {
      const flowId = await startFlow(options, store, scenario, prefix, 'settlement', false, [
        'one',
        'two'
      ])
      const failure = makeSerializedJobFailure({
        kind: 'typed',
        message: 'settlement failure',
        retryable: false,
        recordedAt: 1
      }).unwrap()
      const first = await unwrap(
        store.recordChildResults({
          flowId,
          now: 1,
          reports: [report(flowId, 'one', 'failed', failure)]
        }),
        scenario,
        'child-report'
      )
      assert(first.applied === 1, scenario, 'child-report', 'first report must apply')
      const replay = await unwrap(
        store.recordChildResults({
          flowId,
          now: 2,
          reports: [report(flowId, 'one', 'failed', failure)]
        }),
        scenario,
        'child-report-idempotency'
      )
      assert(
        replay.applied === 0,
        scenario,
        'child-report-idempotency',
        'replay must not double-count'
      )
      const settled = await unwrap(
        store.recordChildResults({
          flowId,
          now: 3,
          reports: [report(flowId, 'two', 'completed')]
        }),
        scenario,
        'child-report'
      )
      assert(
        settled.parent.state === 'waiting',
        scenario,
        'child-settlement',
        'continue flow must collect'
      )
      assert(
        settled.parent.flow.pending === 0,
        scenario,
        'child-settlement',
        'all children must settle'
      )
    }
  },
  {
    id: 'bounded-cascade',
    name: 'bounds reconciliation and makes cascade work retryable',
    category: 'reconciliation',
    body: async (store, scenario) => {
      const flowId = await startFlow(options, store, scenario, prefix, 'cascade', true, [
        'one',
        'two',
        'three'
      ])
      const failure = makeSerializedJobFailure({
        kind: 'typed',
        message: 'cascade failure',
        retryable: false,
        recordedAt: 1
      }).unwrap()
      await unwrap(
        store.recordChildResults({
          flowId,
          now: 1,
          reports: [report(flowId, 'one', 'failed', failure)]
        }),
        scenario,
        'child-report'
      )
      const first = await unwrap(
        store.reconcile({ flowId, observations: [], now: 2, limit: 1 }),
        scenario,
        'reconcile-bound'
      )
      assert(first.cascade.length <= 1, scenario, 'reconcile-bound', 'cascade must obey the limit')
      assert(first.cascade.length === 1, scenario, 'reconcile-bound', 'first page should have work')
      await unwrap(
        store.markCascaded({ flowId, childKeys: [first.cascade[0]!.childKey] }),
        scenario,
        'cascade-ack'
      )
      const retry = await unwrap(
        store.reconcile({ flowId, observations: [], now: 3, limit: 1 }),
        scenario,
        'cascade-retry'
      )
      assert(
        retry.cascade.length === 1,
        scenario,
        'cascade-retry',
        'unacknowledged cascade must reappear'
      )
    }
  }
]

export const flowStoreContract = (options: FlowStoreContractOptions): FlowStoreContractSuite => {
  const prefix = options.prefix ?? `run-${Date.now()}`
  const state = {
    executed: new Set<string>(),
    passed: new Set<string>(),
    failed: new Set<string>()
  }
  const definitions = scenarios(options, prefix)
  const suiteItems: FlowStoreContractScenario[] = definitions.map((definition) => {
    const scenario: FlowStoreContractScenarioInfo = Object.freeze({
      id: definition.id,
      name: definition.name,
      category: definition.category
    })
    return Object.freeze({
      ...scenario,
      run: async (): Promise<void> => {
        state.executed.add(scenario.id)
        let store: FlowStoreV2 | undefined
        try {
          store = await options.makeStore(scenario)
          await definition.body(store, scenario)
          state.passed.add(scenario.id)
        } catch (cause) {
          state.failed.add(scenario.id)
          throw cause
        } finally {
          if (store !== undefined && options.dispose !== undefined) {
            await options.dispose(store, scenario)
          }
        }
      }
    })
  })
  return Object.assign(suiteItems, {
    report: () =>
      Object.freeze({
        version: 1 as const,
        executed: Object.freeze([...state.executed]),
        passed: Object.freeze([...state.passed]),
        failed: Object.freeze([...state.failed])
      })
  })
}
