// oxlint-disable anti-slop/no-unknown-returns -- the test-only Kysely activation helper discards driver result details.
// oxlint-disable typescript/await-thenable -- Bun's promise matchers are awaited at test boundaries.

import { expect, test } from 'bun:test'
import { CurrentAbortSignal, Effect, Layer, Runtime, ServiceRuntime } from 'better-effect'
import { Result } from 'better-result'
import {
  CompiledQuery,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type Dialect,
  type Driver
} from 'kysely'

import { KyselyEffect } from '../src/index.ts'

const service = KyselyEffect.service

interface DatabaseSchema {
  users: {
    id: number
    email: string
  }
}

type DestroyableDriver = Driver & {
  readonly destroyCalls: number
}

class TrackingDriver extends DummyDriver implements DestroyableDriver {
  destroyCalls = 0
  failDestroy = false

  override async acquireConnection() {
    return {
      executeQuery: async () => ({ rows: [] }),
      streamQuery: async function* () {
        yield { rows: [] }
      }
    }
  }

  override async releaseConnection(): Promise<void> {}

  override async beginTransaction(): Promise<void> {}

  override async commitTransaction(): Promise<void> {}

  override async rollbackTransaction(): Promise<void> {}

  override async destroy(): Promise<void> {
    this.destroyCalls += 1

    if (this.failDestroy) {
      throw new Error('driver destroy failed')
    }

    await super.destroy()
  }
}

const makeDialect = (driver: TrackingDriver): Dialect => ({
  createAdapter: () => new PostgresAdapter(),
  createDriver: () => driver,
  createIntrospector: (database) => new PostgresIntrospector(database),
  createQueryCompiler: () => new PostgresQueryCompiler()
})

const makeDatabase = (driver = new TrackingDriver()): Kysely<DatabaseSchema> =>
  new Kysely<DatabaseSchema>({ dialect: makeDialect(driver) })

type ActivatableDatabase = {
  executeQuery(query: CompiledQuery): Promise<object>
}

const activate = async (database: ActivatableDatabase): Promise<void> => {
  await database.executeQuery(CompiledQuery.raw('select 1'))
}

test('rejects construction of the generated token', () => {
  const Database = service<DatabaseSchema>()('@test/NonConstructibleDatabase')
  const layerDescriptor = Object.getOwnPropertyDescriptor(Database, 'layer')
  const succeedDescriptor = Object.getOwnPropertyDescriptor(Database, 'succeed')

  expect(() => Reflect.construct(Database, [])).toThrow('not constructible')
  expect(layerDescriptor).toMatchObject({ configurable: false, enumerable: true, writable: false })
  expect(succeedDescriptor).toMatchObject({
    configurable: false,
    enumerable: true,
    writable: false
  })
})

test('returns the exact borrowed Kysely instance without changing it', async () => {
  const Database = service<DatabaseSchema>()('@test/BorrowedDatabase')
  const driver = new TrackingDriver()
  const kyselyPrototype = Object.getOwnPropertyDescriptors(Kysely.prototype)
  const raw = makeDatabase(driver)
  const beforeOf = Object.getOwnPropertyDescriptors(raw)
  const beforeOfNames = Object.getOwnPropertyNames(raw)
  const beforeOfSymbols = Object.getOwnPropertySymbols(raw)
  const branded = Database.of(raw)

  expect(branded === raw).toBe(true)
  expect(Object.getOwnPropertyDescriptors(raw)).toEqual(beforeOf)
  expect(Object.getOwnPropertyNames(raw)).toEqual(beforeOfNames)
  expect(Object.getOwnPropertySymbols(raw)).toEqual(beforeOfSymbols)

  Object.freeze(branded)
  const ownNames = Object.getOwnPropertyNames(branded)
  const ownSymbols = Object.getOwnPropertySymbols(branded)
  const descriptors = Object.getOwnPropertyDescriptors(branded)
  const prototype = Object.getPrototypeOf(branded)
  const extensible = Object.isExtensible(branded)
  const sealed = Object.isSealed(branded)
  const frozen = Object.isFrozen(branded)

  const runtime = await Runtime.make(Database.succeed(branded))
  const resolved = await runtime.run(() => ServiceRuntime.resolve(Database))

  expect(resolved).toBe(branded)
  expect(Object.getPrototypeOf(resolved)).toBe(prototype)
  expect(Object.getOwnPropertyNames(resolved)).toEqual(ownNames)
  expect(Object.getOwnPropertySymbols(resolved)).toEqual(ownSymbols)
  expect(Object.getOwnPropertyDescriptors(resolved)).toEqual(descriptors)
  expect(Object.getOwnPropertyDescriptors(Kysely.prototype)).toEqual(kyselyPrototype)
  expect(Object.isExtensible(resolved)).toBe(extensible)
  expect(Object.isSealed(resolved)).toBe(sealed)
  expect(Object.isFrozen(resolved)).toBe(frozen)

  await runtime.dispose()
  expect(driver.destroyCalls).toBe(0)
})

test('resolves the exact instance through the public yieldable Service path', async () => {
  const Database = service<DatabaseSchema>()('@test/YieldableDatabase')
  const raw = makeDatabase()
  const runtime = await Runtime.make(Database.succeed(raw))
  const program = Effect.fn(async function* () {
    const database = yield* Database
    await activate(database)
    return Result.ok(database)
  })

  const result = await runtime.run(program)

  expect(result.status).toBe('ok')
  if (result.status === 'ok') {
    expect(result.value === raw).toBe(true)
  }
  await runtime.dispose()
})

test('lazily acquires one owned Kysely instance for concurrent resolutions', async () => {
  const Database = service<DatabaseSchema>()('@test/OwnedDatabase')
  const driver = new TrackingDriver()
  const raw = Database.of(makeDatabase(driver))
  let acquisitions = 0

  const runtime = await Runtime.make(
    Database.layer(async () => {
      acquisitions += 1
      await Promise.resolve()
      return raw
    })
  )

  expect(acquisitions).toBe(0)

  const resolved = await Promise.all(
    Array.from({ length: 8 }, () => runtime.run(() => ServiceRuntime.resolve(Database)))
  )

  expect(acquisitions).toBe(1)
  expect(resolved.every((database) => database === raw)).toBe(true)

  await runtime.run(async () => {
    await activate(raw)
  })
  await runtime.dispose()
  expect(driver.destroyCalls).toBe(1)
  await runtime.dispose()
  expect(driver.destroyCalls).toBe(1)
})

test('destroys an owned database after a failed one-shot execution', async () => {
  const Database = service<DatabaseSchema>()('@test/FailedOwnedDatabase')
  const driver = new TrackingDriver()
  const raw = Database.of(makeDatabase(driver))
  const failure = new Error('program failed')

  await expect(
    Runtime.run(
      Database.layer(() => raw),
      async () => {
        const database = await ServiceRuntime.resolve(Database)
        await activate(database)
        throw failure
      }
    )
  ).rejects.toBe(failure)

  expect(driver.destroyCalls).toBe(1)
})

test('destroys an owned database after a successful one-shot execution', async () => {
  const Database = service<DatabaseSchema>()('@test/SuccessfulOwnedDatabase')
  const driver = new TrackingDriver()
  const raw = makeDatabase(driver)

  const result = await Runtime.run(
    Database.layer(() => raw),
    async () => {
      const database = await ServiceRuntime.resolve(Database)
      await activate(database)
      return 'ok'
    }
  )

  expect(result).toBe('ok')
  expect(driver.destroyCalls).toBe(1)
})

test('preserves Result.err outcomes while releasing owned and borrowed databases', async () => {
  const owned = service<DatabaseSchema>()('@test/ResultErrOwnedDatabase')
  const borrowed = service<DatabaseSchema>()('@test/ResultErrBorrowedDatabase')
  const ownedDriver = new TrackingDriver()
  const borrowedDriver = new TrackingDriver()
  const ownedRaw = makeDatabase(ownedDriver)
  const borrowedRaw = makeDatabase(borrowedDriver)
  const failure = new Error('result failure')

  const ownedResult = await Runtime.run(
    owned.layer(() => ownedRaw),
    async () => {
      await activate(await ServiceRuntime.resolve(owned))
      return Result.err(failure)
    }
  )
  const borrowedResult = await Runtime.run(borrowed.succeed(borrowedRaw), async () => {
    await activate(await ServiceRuntime.resolve(borrowed))
    return Result.err(failure)
  })

  expect(ownedResult.error).toBe(failure)
  expect(borrowedResult.error).toBe(failure)
  expect(ownedDriver.destroyCalls).toBe(1)
  expect(borrowedDriver.destroyCalls).toBe(0)
})

test('does not destroy a database when acquisition fails', async () => {
  const Database = service<DatabaseSchema>()('@test/RejectedDatabase')
  const driver = new TrackingDriver()
  const acquisitionFailure = new Error('acquisition failed')
  const runtime = await Runtime.make(
    Database.layer(async () => {
      throw acquisitionFailure
    })
  )

  await expect(runtime.run(() => ServiceRuntime.resolve(Database))).rejects.toMatchObject({
    cause: acquisitionFailure
  })
  await runtime.dispose()

  expect(driver.destroyCalls).toBe(0)
})

test('releases owned resources after an execution abort', async () => {
  const Database = service<DatabaseSchema>()('@test/AbortedOwnedDatabase')
  const driver = new TrackingDriver()
  const raw = makeDatabase(driver)
  let signalReady!: () => void
  const ready = new Promise<void>((resolve) => {
    signalReady = resolve
  })
  const runtime = await Runtime.make(Database.layer(() => raw))
  const execution = runtime.run(
    Effect.fn(async function* () {
      const database = yield* Database
      await activate(database)
      const signal = yield* CurrentAbortSignal
      signalReady()

      await new Promise<void>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })

      return Result.ok(undefined)
    })
  )

  await ready
  const disposal = runtime.dispose({ abortAfterGracePeriod: true, gracePeriod: 0 })

  await expect(execution).rejects.toBeDefined()
  await disposal
  expect(driver.destroyCalls).toBe(1)
})

test('destroys each independent owned database exactly once', async () => {
  const Primary = service<DatabaseSchema>()('@test/OwnedPrimaryDatabase')
  const Replica = service<DatabaseSchema>()('@test/OwnedReplicaDatabase')
  const primaryDriver = new TrackingDriver()
  const replicaDriver = new TrackingDriver()
  const primary = Primary.of(makeDatabase(primaryDriver))
  const replica = Replica.of(makeDatabase(replicaDriver))
  const runtime = await Runtime.make(
    Layer.merge(
      Primary.layer(() => primary),
      Replica.layer(async () => replica)
    )
  )

  await Promise.all([
    runtime.run(async () => {
      await activate(await ServiceRuntime.resolve(Primary))
    }),
    runtime.run(async () => {
      await activate(await ServiceRuntime.resolve(Replica))
    })
  ])
  await runtime.dispose()
  await runtime.dispose()

  expect(primaryDriver.destroyCalls).toBe(1)
  expect(replicaDriver.destroyCalls).toBe(1)
})

test('reports owned destroy failures as shutdown cleanup diagnostics', async () => {
  const Database = service<DatabaseSchema>()('@test/DestroyFailureDatabase')
  const driver = new TrackingDriver()
  driver.failDestroy = true
  const raw = makeDatabase(driver)
  const diagnostics: unknown[] = []

  await expect(
    Runtime.run(
      Database.layer(() => raw),
      {
        onCleanupFailure: (diagnostic) => {
          diagnostics.push(diagnostic)
        }
      },
      async () => {
        const database = await ServiceRuntime.resolve(Database)
        await activate(database)
        return 'ok'
      }
    )
  ).rejects.toThrow('Failed to dispose Layer')

  expect(driver.destroyCalls).toBe(1)
  expect(diagnostics).toHaveLength(1)
})

test('keeps native Kysely methods and private state usable after resolution', async () => {
  const Database = service<DatabaseSchema>()('@test/NativeDatabase')
  const raw = Database.of(makeDatabase())
  const runtime = await Runtime.make(Database.succeed(raw))

  const resolved = await runtime.run(() => ServiceRuntime.resolve(Database))
  const withSchema = resolved.withSchema('public')
  const withPlugin = resolved.withPlugin({
    transformQuery: ({ node }) => node,
    transformResult: async ({ result }) => result
  })
  const query = resolved.selectFrom('users').selectAll()

  expect(withSchema).toBeInstanceOf(Kysely)
  expect(withPlugin).toBeInstanceOf(Kysely)
  expect(query.compile().sql).toContain('select')

  await runtime.dispose()
})

test('supports independent owned and borrowed databases with different tags', async () => {
  const Primary = service<DatabaseSchema>()('@test/PrimaryDatabase')
  const Analytics = service<{ events: { id: string } }>()('@test/AnalyticsDatabase')
  const primaryDriver = new TrackingDriver()
  const analyticsDriver = new TrackingDriver()
  const primary = Primary.of(makeDatabase(primaryDriver))
  const analytics = Analytics.of(
    new Kysely<{ events: { id: string } }>({
      dialect: makeDialect(analyticsDriver)
    })
  )
  const runtime = await Runtime.make(
    Layer.merge(
      Primary.layer(() => primary),
      Analytics.succeed(analytics)
    )
  )

  const [resolvedPrimary, resolvedAnalytics] = await Promise.all([
    runtime.run(async () => {
      const database = await ServiceRuntime.resolve(Primary)
      await activate(database)
      return database
    }),
    runtime.run(() => ServiceRuntime.resolve(Analytics))
  ])

  expect(resolvedPrimary).toBe(primary)
  expect(resolvedAnalytics).toBe(analytics)
  await runtime.dispose()
  expect(primaryDriver.destroyCalls).toBe(1)
  expect(analyticsDriver.destroyCalls).toBe(0)
})
