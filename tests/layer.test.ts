import { describe, expect, expectTypeOf, mock, test } from 'bun:test'

import { Layer } from '../src/layer'
import { Service } from '../src/service'

class Database extends Service<Database>() {
  constructor(readonly environment = 'live') {
    super()
  }

  query(): string {
    return this.environment
  }
}

class UserRepository extends Service<UserRepository>() {
  findUser(): string {
    return 'user'
  }
}

describe('Layer', () => {
  test('make creates a provider for the service token', async () => {
    const layer = Layer.make(Database, () => new Database())

    expect(layer.providers).toHaveLength(1)

    const provider = layer.providers[0]

    expect(provider).toBeDefined()

    if (!provider) {
      throw new Error('Expected provider')
    }

    expect(provider.service).toBe(Database)

    const instance = await provider.acquire()

    expect(instance).toBeInstanceOf(Database)
  })

  test('succeed always provides the given instance', async () => {
    const database = new Database('test')

    const layer = Layer.succeed(Database, database)

    const provider = layer.providers[0]

    if (!provider) {
      throw new Error('Expected provider')
    }

    expect(provider.service).toBe(Database)

    expect(await provider.acquire()).toBe(database)
  })

  test('scoped associates acquire and release with the same service type', async () => {
    const release = mock(async (database: Database) => {
      expectTypeOf(database).toEqualTypeOf<Database>()
    })

    const layer = Layer.scoped(
      Database,

      () => new Database(),

      release
    )

    const provider = layer.providers[0]

    if (!provider) {
      throw new Error('Expected provider')
    }

    const database = await provider.acquire()

    await provider.release?.(database)

    expect(release).toHaveBeenCalledTimes(1)

    expect(release).toHaveBeenCalledWith(database)
  })

  test('merge combines providers using service tokens', () => {
    const database = Layer.make(Database, () => new Database())

    const users = Layer.make(UserRepository, () => new UserRepository())

    const merged = Layer.merge(database, users)

    expect(merged.providers).toHaveLength(2)

    expect(merged.providers.map(({ service }) => service)).toEqual([Database, UserRepository])
  })

  test('merge rejects the same service token twice', () => {
    const first = Layer.make(Database, () => new Database())

    const second = Layer.make(Database, () => new Database('other'))

    expect(() => Layer.merge(first, second)).toThrow('Duplicate service "Database"')
  })

  test('override replaces a provider by service identity', async () => {
    const liveDatabase = new Database('live')

    const testDatabase = new Database('test')

    const live = Layer.merge(
      Layer.succeed(Database, liveDatabase),

      Layer.make(UserRepository, () => new UserRepository())
    )

    const overridden = Layer.override(
      live,

      Layer.succeed(Database, testDatabase)
    )

    expect(overridden.providers).toHaveLength(2)

    const databaseProvider = overridden.providers.find(({ service }) => service === Database)

    expect(databaseProvider).toBeDefined()

    if (!databaseProvider) {
      throw new Error('Expected Database provider')
    }

    expect(await databaseProvider.acquire()).toBe(testDatabase)
  })

  test('override does not affect unrelated services', () => {
    const app = Layer.merge(
      Layer.make(Database, () => new Database()),

      Layer.make(UserRepository, () => new UserRepository())
    )

    const overridden = Layer.override(
      app,

      Layer.succeed(Database, new Database('test'))
    )

    const repository = overridden.providers.find(({ service }) => service === UserRepository)

    expect(repository).toBeDefined()

    expect(repository?.service).toBe(UserRepository)
  })
})
