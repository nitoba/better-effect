import { expectTypeOf } from 'bun:test'

import type {
  RuntimeExecutionStartEvent,
  RuntimeObserver as RuntimeObserverContract
} from '../../src'
import { MapLayerBackend, type LayerBackend } from '../../src/layer'
import { ExplicitRuntimeContextStorage } from '../../src/runtime/explicit'
import { NodeRuntimeContextStorage } from '../../src/runtime/node'
import {
  layerBackendContract,
  RecordedRuntimeObserver,
  RuntimeGraphObserver,
  RuntimeObserver,
  runtimeContextStorageContract,
  type ContextConcurrency,
  type ContractScenario,
  type LayerBackendAcquisitionFailure,
  type LayerBackendContractOptions,
  type RecordedRuntimeObserverSnapshot,
  type RuntimeContextStorageContractOptions,
  type RuntimeGraphEdge,
  type RuntimeGraphNode,
  type RuntimeGraphObserverOptions,
  type RuntimeGraphSnapshot,
  type RuntimeObserverEvent
} from '../../src/testing'

const mapOptions = {
  makeBackend: () => new MapLayerBackend(),
  acquisitionFailure: 'retry',
  cleanup: async (backend) => backend.disposeAll()
} satisfies LayerBackendContractOptions

expectTypeOf(mapOptions.makeBackend).returns.toMatchTypeOf<LayerBackend>()
expectTypeOf(mapOptions.acquisitionFailure).toEqualTypeOf<'retry'>()
expectTypeOf<LayerBackendAcquisitionFailure>().toEqualTypeOf<'retry' | 'sticky'>()

const layerScenarios = layerBackendContract(mapOptions)
expectTypeOf(layerScenarios).toEqualTypeOf<readonly ContractScenario[]>()
expectTypeOf(layerScenarios[0]?.run).toEqualTypeOf<(() => Promise<void>) | undefined>()

const nodeOptions = {
  makeStorage: () => new NodeRuntimeContextStorage(),
  makeCompanionStorage: () => new ExplicitRuntimeContextStorage(),
  concurrency: 'concurrent',
  isMissingContextError: (cause) => cause instanceof Error,
  isOverlapError: (cause) => cause instanceof Error
} satisfies RuntimeContextStorageContractOptions

expectTypeOf(nodeOptions.concurrency).toEqualTypeOf<'concurrent'>()
expectTypeOf<ContextConcurrency>().toEqualTypeOf<'concurrent' | 'sequential'>()
expectTypeOf(runtimeContextStorageContract(nodeOptions)).toEqualTypeOf<
  readonly ContractScenario[]
>()

runtimeContextStorageContract({
  makeStorage: () => new NodeRuntimeContextStorage(),
  // @ts-expect-error RuntimeContextStorage capability must declare a supported mode.
  concurrency: 'parallel'
})

const recorder = RecordedRuntimeObserver.make()
const composed = RuntimeObserver.compose(recorder)
const snapshot = recorder.snapshot()
const graph = RuntimeGraphObserver.make({ includeFailures: true, rootLabel: 'Runtime' })
const graphSnapshot = graph.toJSON()
const graphOptions: RuntimeGraphObserverOptions = { rootLabel: 'Runtime' }

expectTypeOf(recorder).toMatchTypeOf<RuntimeObserverContract>()
expectTypeOf(composed).toEqualTypeOf<RuntimeObserverContract>()
expectTypeOf(graph).toMatchTypeOf<RuntimeObserverContract>()
expectTypeOf(graphOptions).toMatchTypeOf<RuntimeGraphObserverOptions>()
expectTypeOf<RecordedRuntimeObserverSnapshot['executionStarts']>().toEqualTypeOf<
  readonly RuntimeExecutionStartEvent[]
>()
expectTypeOf<RecordedRuntimeObserverSnapshot['timeline']>().toEqualTypeOf<
  readonly RuntimeObserverEvent[]
>()
expectTypeOf(graphSnapshot).toEqualTypeOf<RuntimeGraphSnapshot>()
expectTypeOf<RuntimeGraphSnapshot['nodes']>().toEqualTypeOf<readonly RuntimeGraphNode[]>()
expectTypeOf<RuntimeGraphSnapshot['edges']>().toEqualTypeOf<readonly RuntimeGraphEdge[]>()
expectTypeOf(snapshot).toEqualTypeOf<RecordedRuntimeObserverSnapshot>()

// @ts-expect-error recorded views are immutable
snapshot.timeline.push({})
// @ts-expect-error graph views are immutable
graphSnapshot.nodes.push({ tag: 'x', resolutions: 0, acquisitions: 0, failures: 0 })
