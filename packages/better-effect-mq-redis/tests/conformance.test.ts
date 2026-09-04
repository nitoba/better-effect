// Redis has no embedded test server, so this suite is skipped unless REDIS_URL is configured.

import { describe, expect, test } from 'bun:test'
import { Layer, Runtime, ServiceRuntime } from 'better-effect'
import { JobStore } from 'better-effect-mq'
import type { AnyJobStoreToken, JobStore as JobStoreType } from 'better-effect-mq'
import { jobStoreContract, type JobStoreContractSynchronization } from 'better-effect-mq/testing'
import { RedisJobStore } from '../src/index'
import type { RedisJobStoreConnectionConfig } from '../src/index'

const url = process.env.REDIS_URL
const integration = url === undefined ? test.skip : test
const prefix = `better-effect-mq-contract-${process.pid}-${Date.now()}`

const namespaceFor = (scenario: string, suffix = '') =>
  `contract-${scenario}${suffix === '' ? '' : `-${suffix}`}`

const configFor = (namespace: string): RedisJobStoreConnectionConfig => {
  const config = { namespace, prefix, validateLayout: true }
  return url === undefined ? config : { ...config, url }
}

const makeLayer = <const Token extends AnyJobStoreToken>(token: Token, namespace: string) =>
  RedisJobStore.layerFromConfigFor(token, configFor(namespace))

const synchronizeStore = (
  store: JobStoreType.Contract,
  synchronization: JobStoreContractSynchronization
): void => {
  const originalAwaitWake = store.awaitWake.bind(store)
  Object.defineProperty(store, 'awaitWake', {
    configurable: true,
    enumerable: false,
    value: (request: JobStoreType.AwaitWakeRequest) => {
      const waiting = originalAwaitWake(request)
      synchronization.ready()
      return Promise.resolve(waiting).then((result) => {
        synchronization.observed()
        return result
      })
    },
    writable: true
  })
}

const suite = jobStoreContract({
  capabilities: {
    notifications: true,
    queueFilteredNotifications: true,
    batchClaim: true,
    transactionalEnqueue: false
  },
  makeRuntime: async (context) => {
    const runtime = await Runtime.make(
      RedisJobStore.layerFromConfig(configFor(namespaceFor(context.id)))
    )
    await runtime.run(async () => {
      synchronizeStore(await ServiceRuntime.resolve(JobStore), context.synchronization)
    })
    return runtime
  },
  makeMultiStoreRuntime: async (context) => {
    const runtime = await Runtime.make(
      Layer.merge(
        RedisJobStore.layerFromConfig(configFor(namespaceFor(context.id, 'default'))),
        makeLayer(context.tokens.first, namespaceFor(context.id, 'first')),
        makeLayer(context.tokens.second, namespaceFor(context.id, 'second'))
      )
    )
    await runtime.run(async () => {
      synchronizeStore(
        await ServiceRuntime.resolve(context.tokens.default),
        context.synchronization
      )
      synchronizeStore(await ServiceRuntime.resolve(context.tokens.first), context.synchronization)
      synchronizeStore(await ServiceRuntime.resolve(context.tokens.second), context.synchronization)
    })
    return runtime
  }
})

describe('Redis JobStore conformance', () => {
  for (const scenario of suite) {
    integration(scenario.name, async () => {
      await scenario.run()
    })
  }

  integration('executes every enabled contract scenario', () => {
    const report = suite.report()
    expect(report.failed).toEqual([])
    expect(report.executed).toHaveLength(suite.length)
    expect(report.passed).toHaveLength(suite.length)
  })
})
