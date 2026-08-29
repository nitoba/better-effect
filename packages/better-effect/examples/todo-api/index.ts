import { Result } from 'better-result'

import {
  CurrentAbortSignal,
  Effect,
  ItiLayerBackend,
  NodeRuntime,
  Scope,
  ServiceRuntime
} from './better-effect'
import { AppLive } from './layers/app-live'
import { seedDemoUser } from './seed'
import { createServer } from './server'

const main = Effect.fn(async function* () {
  const resolver = ServiceRuntime.current()
  const scope = yield* Scope
  yield* Result.await(Promise.resolve(seedDemoUser()))

  const signal = yield* CurrentAbortSignal
  const server = createServer(resolver, scope)

  try {
    console.log(`TODO API running at ${server.url.toString()}`)
    console.log('Demo credentials: demo@example.com / demo1234')

    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve()
      } else {
        signal.addEventListener('abort', () => resolve(), { once: true })
      }
    })

    return Result.ok(undefined)
  } finally {
    await server.stop()
  }
})

await NodeRuntime.runMain(
  AppLive,
  {
    backend: new ItiLayerBackend(),
    onFailure: (error) => {
      console.error(error)
      return 1
    },
    onDefect: (cause) => {
      console.error(cause)
      return 1
    }
  },
  main
)
