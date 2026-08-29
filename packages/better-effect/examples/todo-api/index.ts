import { Result } from 'better-result'

import {
  CurrentAbortSignal,
  Effect,
  ItiLayerBackend,
  Layer,
  NodeRuntime,
  Runtime
} from './better-effect'
import { AppLive } from './layers/app-live'
import { seedDemoUser } from './seed'
import { createServer } from './server'

const runtime = await Runtime.make(AppLive, {
  backend: new ItiLayerBackend()
})

const seed = await runtime.run(seedDemoUser)

if (Result.isError(seed)) {
  await runtime.dispose()
  throw seed.error
}

let server: ReturnType<typeof createServer> | undefined

try {
  await NodeRuntime.runMain(
    Layer.empty,
    Effect.fn(async function* () {
      const signal = yield* CurrentAbortSignal
      const startedServer = createServer(runtime, signal)
      server = startedServer

      console.log(`TODO API running at ${startedServer.url.toString()}`)
      console.log('Demo credentials: demo@example.com / demo1234')

      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve()
        } else {
          signal.addEventListener('abort', () => resolve(), { once: true })
        }
      })

      return Result.ok(undefined)
    }),
    {
      onDefect: (cause) => {
        console.error(cause)
        return 1
      }
    }
  )
} finally {
  try {
    await server?.stop()
  } finally {
    await runtime.dispose()
  }
}
