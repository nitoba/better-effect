// Redis has no embedded test server, so this suite is skipped unless REDIS_URL is configured.
// oxlint-disable anti-slop/no-runtime-typeof -- Redis SCAN replies are validated at this test I/O boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- Redis SCAN replies are parsed at this test I/O boundary.

import { describe, expect, test } from 'bun:test'
import { Layer, Runtime, ServiceRuntime } from 'better-effect'
import { JobEventStore, JobStore } from 'better-effect-mq'
import type {
  AnyJobStoreToken,
  JobEventStore as JobEventStoreType,
  JobStore as JobStoreType
} from 'better-effect-mq'
import {
  jobEventStoreContract,
  jobStoreContract,
  type JobEventStoreContractFactoryOptions,
  type JobEventStoreContractSuite,
  type JobStoreContractSynchronization
} from 'better-effect-mq/testing'
import { RedisClient, RedisJobStore } from '../src/index'
import { sendRedisCommand } from '../src/config'
import type { RedisJobStoreConfig, RedisJobStoreConnectionConfig } from '../src/index'

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
    queueFilteredNotifications: true,
    nativeBatchEnqueue: true,
    nativeBatchClaim: true,
    metadataIndex: 'none',
    transactionalEnqueue: false,
    durableChangeFeed: false,
    globalConcurrency: false,
    rateLimiting: false
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
    expect(report.capabilities).toEqual({
      queueFilteredNotifications: true,
      nativeBatchEnqueue: true,
      nativeBatchClaim: true,
      metadataIndex: 'none',
      transactionalEnqueue: false,
      durableChangeFeed: false,
      globalConcurrency: false,
      rateLimiting: false
    })
    expect(report.descriptor?.capabilities).toEqual(report.capabilities)
    expect(report.capabilitiesNotTested).toEqual([])
  })
})

type EventContractRuntime = Awaited<ReturnType<typeof Runtime.make>>

interface EventContractRuntimeState {
  readonly runtime: EventContractRuntime
  readonly namespace: string
  readonly connection: RedisJobStoreConnectionConfig
  readonly client: RedisClient | undefined
}

type EventContractMode = 'clients' | 'config'

const eventPrefix = `better-effect-mq-event-contract-${process.pid}-${Date.now()}`
let eventSequence = 0

const eventNamespace = (mode: EventContractMode, suffix = ''): string => {
  const sequence = eventSequence++
  return `event-contract-${mode}-${process.pid}-${sequence}${suffix}`
}

const eventConnectionFor = (namespace: string): RedisJobStoreConnectionConfig => {
  const config = { namespace, prefix: eventPrefix, validateLayout: true }
  return url === undefined ? config : { ...config, url }
}

const scanPatternFor = (base: string): string =>
  `${base.replaceAll('\\', '\\\\').replaceAll('*', '\\*').replaceAll('?', '\\?').replaceAll('[', '\\[')}:*`

type RedisScanReply = readonly [cursor: string, keys: readonly string[]]

const parseScanReply = (reply: unknown): RedisScanReply => {
  if (!Array.isArray(reply) || reply.length !== 2) {
    throw new Error('Redis namespace cleanup returned an invalid SCAN reply')
  }
  const nextCursor = reply[0]
  const discovered = reply[1]
  if (typeof nextCursor !== 'string' || !Array.isArray(discovered)) {
    throw new Error('Redis namespace cleanup returned an invalid SCAN payload')
  }
  const keys: string[] = []
  for (const key of discovered) {
    if (typeof key !== 'string') {
      throw new Error('Redis namespace cleanup returned an invalid SCAN key')
    }
    keys.push(key)
  }
  return [nextCursor, keys]
}

const clearNamespace = async (client: RedisClient): Promise<void> => {
  let cursor = '0'
  do {
    const [nextCursor, discovered] = parseScanReply(
      await sendRedisCommand(client.client, [
        'SCAN',
        cursor,
        'MATCH',
        scanPatternFor(client.layout.base),
        'COUNT',
        '256'
      ])
    )
    const keys = discovered.filter(
      (key): key is string => typeof key === 'string' && key.startsWith(`${client.layout.base}:`)
    )
    if (keys.length > 0) await sendRedisCommand(client.client, ['DEL', ...keys], client.layout.base)
    cursor = nextCursor
  } while (cursor !== '0')
}

const makeEventContractRuntime = async (
  mode: EventContractMode,
  namespace: string,
  options: JobEventStoreContractFactoryOptions | undefined,
  withEvents: boolean
): Promise<EventContractRuntimeState> => {
  const connection = eventConnectionFor(namespace)
  if (mode === 'config') {
    if (withEvents) {
      const runtime = await Runtime.make(
        RedisJobStore.layerWithEventsFromConfig(connection, options)
      )
      return { runtime, namespace, connection, client: undefined }
    }
    const runtime = await Runtime.make(RedisJobStore.layerFromConfig(connection))
    return { runtime, namespace, connection, client: undefined }
  }

  const client = await RedisClient.fromConfig(connection)
  try {
    const config: RedisJobStoreConfig = {
      client: client.client,
      namespace,
      prefix: eventPrefix,
      validateLayout: true
    }
    if (withEvents) {
      const runtime = await Runtime.make(RedisJobStore.layerWithEvents(config, options))
      return { runtime, namespace, connection, client }
    }
    const runtime = await Runtime.make(RedisJobStore.layer(config))
    return { runtime, namespace, connection, client }
  } catch (cause) {
    await client.dispose()
    throw cause
  }
}

const makeEventSuite = (mode: EventContractMode): JobEventStoreContractSuite => {
  type EventContractStore = JobEventStoreType.Contract | JobStoreType.Contract
  const states = new Map<EventContractStore, EventContractRuntimeState>()

  const stateFor = (store: EventContractStore): EventContractRuntimeState => {
    const state = states.get(store)
    if (state === undefined) throw new Error('Redis event contract runtime state is missing')
    return state
  }

  return jobEventStoreContract({
    capabilities: {
      retention: true,
      cursorExpiry: true,
      optionalEventStore: true
    },
    makeEventStore: async (options) => {
      const state = await makeEventContractRuntime(mode, eventNamespace(mode), options, true)
      const eventStore = await state.runtime.run(() => ServiceRuntime.resolve(JobEventStore))
      states.set(eventStore, state)
      return eventStore
    },
    makeJobStore: async (eventStore) => {
      const state = stateFor(eventStore)
      const jobStore = await state.runtime.run(() => ServiceRuntime.resolve(JobStore))
      states.set(jobStore, state)
      return jobStore
    },
    makeJobStoreWithoutEventStore: async () => {
      const state = await makeEventContractRuntime(
        mode,
        eventNamespace(mode, '-job-only'),
        undefined,
        false
      )
      const jobStore = await state.runtime.run(() => ServiceRuntime.resolve(JobStore))
      states.set(jobStore, state)
      return jobStore
    },
    reset: async (context) => {
      const uniqueStates = new Set<EventContractRuntimeState>([
        stateFor(context.eventStore),
        stateFor(context.jobStore)
      ])
      const failures: unknown[] = []
      for (const state of uniqueStates) {
        try {
          await state.runtime.dispose()
        } catch (cause) {
          failures.push(cause)
        }
      }
      for (const state of uniqueStates) {
        try {
          if (state.client !== undefined) {
            await clearNamespace(state.client)
          } else {
            const cleanupClient = await RedisClient.fromConfig(state.connection)
            try {
              await clearNamespace(cleanupClient)
            } finally {
              await cleanupClient.dispose()
            }
          }
        } catch (cause) {
          failures.push(cause)
        } finally {
          if (state.client !== undefined) {
            try {
              await state.client.dispose()
            } catch (cause) {
              failures.push(cause)
            }
          }
        }
      }
      for (const [store, state] of states) {
        if (uniqueStates.has(state)) states.delete(store)
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1)
        throw new AggregateError(failures, 'Redis event contract cleanup failed')
    }
  })
}

const eventSuites = [
  {
    mode: 'clients' as const,
    name: 'RedisJobStore.layerWithEvents',
    suite: makeEventSuite('clients')
  },
  {
    mode: 'config' as const,
    name: 'RedisJobStore.layerWithEventsFromConfig',
    suite: makeEventSuite('config')
  }
] as const

describe('Redis JobEventStore conformance', () => {
  for (const { name, suite } of eventSuites) {
    describe(name, () => {
      for (const scenario of suite) {
        integration(scenario.name, async () => {
          await scenario.run()
        })
      }

      integration('executes every enabled durable event contract scenario', () => {
        const report = suite.report()
        expect(report.failed).toEqual([])
        expect(report.executed).toHaveLength(suite.length)
        expect(report.passed).toHaveLength(suite.length)
        expect(report.skipped.map(({ id }) => id)).toEqual([
          'event-await-result-race',
          'event-wake-lost-poll-fallback',
          'event-cancel-timeout-shutdown',
          'event-required-extension',
          'event-flow-transitions',
          'event-schedule-transitions'
        ])
      })
    })
  }
})
