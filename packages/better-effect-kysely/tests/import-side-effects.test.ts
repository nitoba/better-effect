import { expect, test } from 'bun:test'
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler
} from 'kysely'

class CountingDriver extends DummyDriver {
  initCalls = 0

  override async init(): Promise<void> {
    this.initCalls += 1
  }
}

test('imports without changing Kysely prototypes or creating a driver connection', async () => {
  const driver = new CountingDriver()
  const database = new Kysely<Record<string, never>>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (value) => new PostgresIntrospector(value),
      createQueryCompiler: () => new PostgresQueryCompiler()
    }
  })
  const query = database.selectFrom('users').selectAll()
  const prototypes = [
    Object.getPrototypeOf(database),
    Object.getPrototypeOf(database.schema),
    Object.getPrototypeOf(query)
  ]
  const descriptors = prototypes.map((prototype) => Object.getOwnPropertyDescriptors(prototype))

  const module = await import('../src/index.ts')

  expect(module.KyselyEffect).toBeDefined()
  expect(driver.initCalls).toBe(0)
  for (const [index, prototype] of prototypes.entries()) {
    expect(Object.getOwnPropertyDescriptors(prototype)).toEqual(descriptors[index]!)
  }
  expect(Object.getPrototypeOf(query)).toBe(prototypes[2])
  expect(query.execute !== undefined).toBe(true)
  expect(Symbol.iterator in query).toBe(false)
  expect(Symbol.asyncIterator in query).toBe(false)

  const nativeExecution = query.execute()
  expect(nativeExecution).toBeInstanceOf(Promise)
  await nativeExecution.catch(() => undefined)
})
