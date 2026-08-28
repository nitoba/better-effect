import { describe, expect, test } from 'bun:test'

import { ItiLayerBackend } from '../src/adapters/iti'
import { MapLayerBackend } from '../src/layer'
import { ExplicitRuntimeContextStorage } from '../src/runtime/explicit'
import { NodeRuntimeContextStorage } from '../src/runtime/node'
import {
  ConformanceError,
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

class ThreeTimerDelayedDisposalBackend extends MapLayerBackend {
  override async disposeAll(): Promise<void> {
    for (let turn = 0; turn < 3; turn++) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0)
      })
    }
  }
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

test('LayerBackend contract rejects three-timer disposal without acquisition tracking', async () => {
  const scenario = layerBackendContract({
    makeBackend: () => new ThreeTimerDelayedDisposalBackend(),
    acquisitionFailure: 'retry'
  }).find((candidate) => candidate.name === 'LayerBackend disposal waits for in-flight acquisition')

  if (!scenario) {
    throw new Error('LayerBackend disposal scenario is not registered')
  }

  const outcome = await scenario.run().then(
    () => ({ rejected: false as const }),
    (cause) => ({ rejected: true as const, cause })
  )

  expect(outcome.rejected).toBe(true)

  if (outcome.rejected) {
    expect(outcome.cause).toBeInstanceOf(ConformanceError)
  }
})

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
