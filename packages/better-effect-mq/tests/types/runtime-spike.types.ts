import { Effect, Layer, Runtime, Service } from 'better-effect'
import { Result } from 'better-result'
import { JobStore } from '../../src'
import { jobStoreContract } from '../../src/testing'
import type { JobStoreContractRuntime, JobStoreContractRuntimeFactory } from '../../src/testing'

import { makeMemoryJobStore } from '../helpers/memory-job-store'

const store = makeMemoryJobStore()

const defaultLayer = Layer.succeed(JobStore, JobStore.of(store))
const defaultRuntime = await Runtime.make(defaultLayer)
const defaultAdapter: JobStoreContractRuntime<InstanceType<typeof JobStore>> = {
  run: (program, options) => defaultRuntime.run(program, options),
  dispose: () => defaultRuntime.dispose()
}

const defaultFactory: JobStoreContractRuntimeFactory = async (context) => {
  const layer = Layer.succeed(context.token, context.token.of(store))
  const runtime = await Runtime.make(layer)
  return {
    run: (program, options) => runtime.run(program, options),
    dispose: () => runtime.dispose()
  }
}

const named = JobStore.named('spike')
const namedLayer = Layer.succeed(named, named.of(store))
const namedRuntime = await Runtime.make(namedLayer)
const namedAdapter: JobStoreContractRuntime<InstanceType<typeof named>> = {
  run: (program, options) => namedRuntime.run(program, options),
  dispose: () => namedRuntime.dispose()
}

const namedFactory: JobStoreContractRuntimeFactory<typeof named> = async (context) => {
  const layer = Layer.succeed(context.token, context.token.of(store))
  const runtime = await Runtime.make(layer)
  return {
    run: (program, options) => runtime.run(program, options),
    dispose: () => runtime.dispose()
  }
}

class RequiredService extends Service<RequiredService>()('RequiredService') {}
const incompleteProgram = Effect.gen(async function* () {
  const required = yield* RequiredService
  return Result.ok(required)
})
// @ts-expect-error The adapter's Runtime environment does not provide RequiredService.
void defaultAdapter.run(incompleteProgram)

const defaultSuite = jobStoreContract({ makeRuntime: defaultFactory })
const namedSuite = jobStoreContract({ token: named, makeRuntime: namedFactory })

void defaultAdapter
void defaultFactory
void namedAdapter
void namedFactory
void defaultSuite
void namedSuite
