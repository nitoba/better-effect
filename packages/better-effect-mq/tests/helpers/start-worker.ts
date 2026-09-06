import { Effect } from 'better-effect'
import type { RuntimeExecutor } from 'better-effect'
import { Result, type Result as ResultType } from 'better-result'

import { JobDefinitionError } from '../../src/protocol'
import { assertJobStoreProtocolCompatible } from '../../src/store'
import type { AnyJobStoreToken, JobStore as JobStoreNamespace } from '../../src/store'
import { normalizeWorkerOptions, WorkerSupervisor } from '../../src/worker/supervisor'
import type { AnyWorkerHandler, WorkerHandle, WorkerOptions } from '../../src/worker/types'

/**
 * Start a supervisor for focused behavior tests without reintroducing an
 * imperative Worker entrypoint into the package API.
 */
export const startWorkerForTest = async (
  executor: RuntimeExecutor<any>,
  options: WorkerOptions<readonly AnyWorkerHandler[]>
): Promise<WorkerHandle> => {
  const seen = new Set<string>()
  for (const handler of options.handlers) {
    const identity = JSON.stringify([handler.job.queue, handler.job.name, handler.job.version])
    if (seen.has(identity)) {
      throw new JobDefinitionError({
        field: 'handlers',
        message: `duplicate handler identity ${identity}`
      })
    }
    seen.add(identity)
  }

  const stores = new Map<string, AnyJobStoreToken>()
  for (const handler of options.handlers) {
    stores.set(handler.job.store.serviceTag, handler.job.store)
  }
  for (const token of stores.values()) {
    // SAFETY: the test helper deliberately erases the heterogeneous executor result at this boundary.
    const result = (await executor.run(() => {
      // SAFETY: the generator yields the token being checked and returns a Result for the erased executor.
      return Effect.gen(async function* () {
        const store = yield* token
        return Result.ok(store)
      }) as never
    })) as ResultType<JobStoreNamespace.Contract, unknown>
    if (Result.isError(result)) throw result.error
    assertJobStoreProtocolCompatible(result.value.descriptor)
  }

  const worker = new WorkerSupervisor(executor, options.handlers, normalizeWorkerOptions(options))
  worker.start()
  return worker
}
