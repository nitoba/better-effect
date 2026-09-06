// oxlint-disable anti-slop/no-chained-type-assertions -- type fixtures intentionally erase runtime values.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- assertions are the subject of these contracts.

import { expectTypeOf } from 'bun:test'
import { ClockTest } from 'better-effect/standard-services'

import { JobScheduleStore, JobStore } from '../../src'
import type { JobScheduleStoreContract, JobStoreContract } from '../../src'
import { jobScheduleStoreContract } from '../../src/testing'
import type {
  JobScheduleStoreContractClient,
  JobScheduleStoreContractContext,
  JobScheduleStoreContractExtension,
  JobScheduleStoreContractOptions,
  JobScheduleStoreContractReport,
  JobScheduleStoreContractScenario,
  JobScheduleStoreContractScheduleContext,
  JobScheduleStoreContractStoreContext,
  JobScheduleStoreContractSuite
} from '../../src/testing'

const jobStore = undefined as unknown as JobStoreContract
const scheduleStore = undefined as unknown as JobScheduleStoreContract

const options: JobScheduleStoreContractOptions = {
  clock: new ClockTest(0),
  makeStore: async (context) => {
    expectTypeOf(context.token).toEqualTypeOf<typeof JobStore>()
    expectTypeOf(context.scheduleToken).toEqualTypeOf<typeof JobScheduleStore>()
    expectTypeOf(context).toMatchTypeOf<JobScheduleStoreContractStoreContext>()
    return jobStore
  },
  makeScheduleStore: async (context) => {
    expectTypeOf(context.jobStore).toEqualTypeOf<JobStoreContract>()
    expectTypeOf(context).toMatchTypeOf<JobScheduleStoreContractScheduleContext>()
    return scheduleStore
  }
}

const suite = jobScheduleStoreContract(options)
const scenario: JobScheduleStoreContractScenario = suite[0]!
const report: JobScheduleStoreContractReport = suite.report()
const contextConsumer = (_context: JobScheduleStoreContractContext): void => {}
const client: JobScheduleStoreContractClient =
  undefined as unknown as JobScheduleStoreContractClient

void scenario
void report
void contextConsumer
void client

const Named = JobStore.named('schedule-types')
const NamedSchedules = JobScheduleStore.for(Named)
const namedOptions: JobScheduleStoreContractOptions<typeof NamedSchedules> = {
  makeStore: (context) => {
    expectTypeOf(context.token).toEqualTypeOf<typeof Named>()
    return jobStore
  },
  makeScheduleStore: (context) => {
    expectTypeOf(context.scheduleToken).toEqualTypeOf<typeof NamedSchedules>()
    return scheduleStore
  }
}

const namedSuite: JobScheduleStoreContractSuite = jobScheduleStoreContract({
  ...namedOptions,
  token: NamedSchedules
})

const extension: JobScheduleStoreContractExtension<typeof NamedSchedules> = {
  id: 'named-extension',
  name: 'named extension',
  category: 'types',
  run: async (context) => {
    expectTypeOf(context.client.token).toEqualTypeOf<typeof NamedSchedules>()
    expectTypeOf(context.client.jobStoreToken).toEqualTypeOf<typeof Named>()
  }
}

const extendedSuite: JobScheduleStoreContractSuite = jobScheduleStoreContract({
  ...namedOptions,
  token: NamedSchedules,
  extensions: [extension]
})

void namedSuite
void extendedSuite

// @ts-expect-error The schedule conformance API intentionally does not accept a Runtime-first factory.
jobScheduleStoreContract({ makeRuntime: async () => undefined })
