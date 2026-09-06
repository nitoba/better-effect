import { describe, expect, test } from 'bun:test'
import { MemoryOutboxStore } from '../src'
import { outboxStoreContract } from '../src/testing'

const suite = outboxStoreContract({
  makeOutboxStore: (_name) => MemoryOutboxStore.make(),
  clock: () => {
    let current = 0
    return {
      now: () => current,
      advance: (milliseconds: number) => {
        current += milliseconds
      }
    }
  }
})

describe('outboxStoreContract', () => {
  test('returns runner-agnostic scenario descriptors', () => {
    expect(suite.length).toBeGreaterThan(0)
    for (const scenario of suite) {
      expect(scenario.id).toEqual(expect.any(String))
      expect(scenario.name).toEqual(expect.any(String))
      expect(scenario.category).toEqual(expect.any(String))
      expect(scenario.run).toEqual(expect.any(Function))
    }
  })

  test('runs every scenario and reports execution without owning a test runner', async () => {
    for (const scenario of suite) {
      await scenario.run()
    }
    const report = suite.report()
    expect(report.version).toBe(1)
    expect(report.executed).toHaveLength(suite.length)
    expect(report.passed).toHaveLength(suite.length)
    expect(report.failed).toEqual([])
  })
})
