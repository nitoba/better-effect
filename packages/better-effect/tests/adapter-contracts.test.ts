import { describe, expect, test } from 'bun:test'

import { ItiLayerBackend } from '../src/adapters/iti'
import {
  MapLayerBackend,
  type LayerBackend,
  type LayerBackendDisposeOptions,
  type LayerRegistration
} from '../src/layer'
import { type AnyServiceToken } from '../src/service'
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

abstract class DelegatingMutationBackend implements LayerBackend {
  protected readonly delegate = new MapLayerBackend()

  protected pendingAcquisition: Promise<unknown> | undefined

  register(registration: LayerRegistration): void {
    this.delegate.register(registration)
  }

  resolve<T extends AnyServiceToken>(token: T): Promise<InstanceType<T>> {
    const acquisition = this.delegate.resolve(token)

    this.pendingAcquisition = acquisition
    void acquisition.then(
      () => {
        if (this.pendingAcquisition === acquisition) {
          this.pendingAcquisition = undefined
        }
      },
      () => {
        if (this.pendingAcquisition === acquisition) {
          this.pendingAcquisition = undefined
        }
      }
    )

    return acquisition
  }

  abstract disposeAll(options?: LayerBackendDisposeOptions): void | PromiseLike<void>
}

class NonWaitingCallbackIgnoringBackend extends DelegatingMutationBackend {
  override disposeAll(options?: LayerBackendDisposeOptions): void | Promise<void> {
    if (options === undefined) {
      return this.delegate.disposeAll()
    }

    options.onPendingAcquisitions?.([Promise.resolve()])
  }
}

class FakePendingAcquisitionBackend extends DelegatingMutationBackend {
  override disposeAll(options?: LayerBackendDisposeOptions): void | PromiseLike<void> {
    if (options === undefined) {
      return this.delegate.disposeAll()
    }

    return options.onPendingAcquisitions?.([Promise.resolve()])
  }
}

class NonAwaitingPendingCallbackBackend extends DelegatingMutationBackend {
  override disposeAll(options?: LayerBackendDisposeOptions): void | Promise<void> {
    if (options === undefined) {
      return this.delegate.disposeAll()
    }

    if (this.pendingAcquisition !== undefined) {
      options.onPendingAcquisitions?.([this.pendingAcquisition])
    }

    return Promise.resolve()
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

const pendingAcquisitionScenario = (makeBackend: () => LayerBackend): ContractScenario => {
  const scenario = layerBackendContract({
    makeBackend,
    acquisitionFailure: 'retry'
  }).find((candidate) => candidate.name === 'LayerBackend disposal waits for in-flight acquisition')

  if (!scenario) {
    throw new Error('LayerBackend disposal scenario is not registered')
  }

  return scenario
}

const expectPendingAcquisitionScenarioToReject = async (
  makeBackend: () => LayerBackend
): Promise<void> => {
  const outcome = await pendingAcquisitionScenario(makeBackend)
    .run()
    .then(
      () => ({ rejected: false as const }),
      (cause) => ({ rejected: true as const, cause })
    )

  expect(outcome.rejected).toBe(true)

  if (outcome.rejected) {
    expect(outcome.cause).toBeInstanceOf(ConformanceError)
  }
}

test('LayerBackend contract rejects three-timer disposal without acquisition tracking', async () => {
  await expectPendingAcquisitionScenarioToReject(() => new ThreeTimerDelayedDisposalBackend())
})

test('LayerBackend contract rejects a callback-ignoring non-waiting disposal', async () => {
  await expectPendingAcquisitionScenarioToReject(() => new NonWaitingCallbackIgnoringBackend())
})

test('LayerBackend contract rejects a settled fake pending acquisition', async () => {
  await expectPendingAcquisitionScenarioToReject(() => new FakePendingAcquisitionBackend())
})

test('LayerBackend contract rejects a non-awaited callback with a real pending acquisition', async () => {
  await expectPendingAcquisitionScenarioToReject(() => new NonAwaitingPendingCallbackBackend())
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
