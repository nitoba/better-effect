import { Result } from 'better-result'

import { ItiLayerBackend, Runtime } from './better-effect'
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

const server = createServer(runtime)

console.log(`TODO API running at ${server.url.toString()}`)

console.log('Demo credentials: demo@example.com / demo1234')

let shuttingDown = false

const shutdown = async () => {
  if (shuttingDown) {
    return
  }

  shuttingDown = true

  await server.stop()
  await runtime.dispose()
}

process.once('SIGINT', () => {
  void shutdown()
})

process.once('SIGTERM', () => {
  void shutdown()
})
