import { JobStore } from '../../src'
import { jobStoreContract } from '../../src/testing'

import type {
  ContractScenario,
  JobStoreContractClient,
  JobStoreContractContext,
  JobStoreContractControls,
  JobStoreContractExtension,
  JobStoreContractMultiStoreRuntime,
  JobStoreContractOptions,
  JobStoreContractReport,
  JobStoreContractRuntime,
  JobStoreContractSuite,
  JobStoreContractSynchronization
} from '../../src/testing'

const runtime: JobStoreContractRuntime<InstanceType<typeof JobStore>> = {
  run: async <Value>(program: () => Value | PromiseLike<Value>): Promise<Awaited<Value>> =>
    await program(),
  dispose: async () => {}
}

const controls: JobStoreContractControls = {
  clock: {
    now: () => 1_700_000_000_000,
    advance: (_milliseconds) => {}
  },
  ids: {
    // SAFETY: type-only fixtures use valid nominal placeholder strings.
    jobId: (_label) => 'job' as never,
    // SAFETY: type-only fixtures use valid nominal placeholder strings.
    leaseToken: (_label) => 'lease' as never,
    // SAFETY: type-only fixtures use valid nominal placeholder strings.
    workerId: (_label) => 'worker' as never
  },
  barrier: {
    wait: async (_name) => {},
    release: (_name) => {},
    reset: (_name) => {}
  },
  synchronization: {
    ready: () => {},
    observed: () => {},
    waitUntilReady: async () => {},
    waitUntilObserved: async () => {},
    waitForDelivery: async () => {},
    release: () => {},
    reset: () => {}
  },
  hooks: {
    checkpoint: async (_point, _scenario) => {}
  }
}

const synchronization: JobStoreContractSynchronization = controls.synchronization!
void synchronization

const extension: JobStoreContractExtension = {
  id: 'extension',
  name: 'extension',
  category: 'extension',
  requires: 'queueFilteredNotifications',
  run: async (context) => {
    const client: JobStoreContractClient = context.client
    void client
  }
}

const contextConsumer = (_context: JobStoreContractContext): void => {}
const options: JobStoreContractOptions = {
  makeRuntime: async (context) => {
    contextConsumer(context)
    return runtime
  },
  controls: () => controls,
  capabilities: {
    queueFilteredNotifications: true,
    nativeBatchEnqueue: false,
    nativeBatchClaim: false,
    metadataIndex: 'none',
    transactionalEnqueue: false,
    durableChangeFeed: false,
    globalConcurrency: false,
    rateLimiting: false
  },
  extensions: [extension]
}

const suite: JobStoreContractSuite = jobStoreContract(options)
const multiRuntime: JobStoreContractMultiStoreRuntime = {
  run: async <Value>(program: () => Value | PromiseLike<Value>): Promise<Awaited<Value>> =>
    await program(),
  dispose: async () => {}
}
const multiOptions: JobStoreContractOptions = {
  ...options,
  makeMultiStoreRuntime: async (context) => {
    void context.tokens.default
    void context.tokens.first
    void context.tokens.second
    return multiRuntime
  }
}
const multiSuite: JobStoreContractSuite = jobStoreContract(multiOptions)
const scenario: ContractScenario = suite[0]!
const report: JobStoreContractReport = suite.report()

void multiSuite

void scenario
void report
