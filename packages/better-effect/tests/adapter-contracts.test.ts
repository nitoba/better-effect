import { describe, test } from 'bun:test'

import { ItiLayerBackend } from '../src/adapters/iti'
import { MapLayerBackend } from '../src/layer'
import { ExplicitRuntimeContextStorage } from '../src/runtime/explicit'
import { NodeRuntimeContextStorage } from '../src/runtime/node'
import {
  layerBackendContract,
  runtimeContextStorageContract,
  type ContractScenario
} from '../src/testing'

const register = (name: string, scenarios: readonly ContractScenario[]): void => {
  describe(name, () => {
    for (const scenario of scenarios) {
      test(scenario.name, scenario.run)
    }
  })
}

register(
  'MapLayerBackend conformance',
  layerBackendContract({
    makeBackend: () => new MapLayerBackend(),
    acquisitionFailure: 'retry'
  })
)

register(
  'ItiLayerBackend conformance',
  layerBackendContract({
    makeBackend: () => new ItiLayerBackend(),
    acquisitionFailure: 'sticky'
  })
)

register(
  'NodeRuntimeContextStorage conformance',
  runtimeContextStorageContract({
    makeStorage: () => new NodeRuntimeContextStorage(),
    makeCompanionStorage: () => new ExplicitRuntimeContextStorage(),
    concurrency: 'concurrent'
  })
)

register(
  'ExplicitRuntimeContextStorage conformance',
  runtimeContextStorageContract({
    makeStorage: () => new ExplicitRuntimeContextStorage(),
    makeCompanionStorage: () => new NodeRuntimeContextStorage(),
    concurrency: 'sequential'
  })
)
