import { expectTypeOf } from 'bun:test'
import { MemoryOutboxStore } from '../../src'
import { outboxStoreContract } from '../../src/testing'

import type {
  OutboxStoreContractClock,
  OutboxStoreContractOptions,
  OutboxStoreContractScenario,
  OutboxStoreContractSuite
} from '../../src/testing'

const clock: OutboxStoreContractClock = {
  now: () => 1_700_000_000_000,
  advance: (_milliseconds) => {}
}

const options: OutboxStoreContractOptions<MemoryOutboxStore> = {
  makeOutboxStore: async (_name) => MemoryOutboxStore.make(),
  clock
}

const suite: OutboxStoreContractSuite = outboxStoreContract(options)
const scenario = suite[0]!

expectTypeOf(scenario).toMatchTypeOf<OutboxStoreContractScenario>()
expectTypeOf(scenario.id).toEqualTypeOf<string>()
expectTypeOf(scenario.name).toEqualTypeOf<string>()
expectTypeOf(scenario.category).toEqualTypeOf<string>()
expectTypeOf(scenario.run()).toEqualTypeOf<Promise<void>>()
expectTypeOf(suite.report()).toMatchTypeOf<{ readonly failed: readonly string[] }>()

void suite
