import { expectTypeOf } from 'bun:test'

import { MapLayerBackend, type LayerBackend } from '../../src/layer'
import { ExplicitRuntimeContextStorage } from '../../src/runtime/explicit'
import { NodeRuntimeContextStorage } from '../../src/runtime/node'
import {
  layerBackendContract,
  runtimeContextStorageContract,
  type ContextConcurrency,
  type ContractScenario,
  type LayerBackendAcquisitionFailure,
  type LayerBackendContractOptions,
  type RuntimeContextStorageContractOptions
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
