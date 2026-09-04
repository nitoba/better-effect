import { expect, test } from 'bun:test'
import {
  bindPortsToLoopback,
  ContainerLifecycle,
  hasOnlyLoopbackBindings
} from './mq-container-support'

test('database port bindings are loopback-only', () => {
  const bindings = {
    '27017/tcp': [{ HostPort: '0' }],
    '3306/tcp': [{ HostPort: '0' }]
  }

  bindPortsToLoopback(bindings)

  expect(hasOnlyLoopbackBindings(bindings)).toBe(true)
})

test('cleanup drains a container that completes startup after cleanup begins', async () => {
  let finishStartup: (() => void) | undefined
  const startup = new Promise<void>((resolve) => {
    finishStartup = resolve
  })
  let stopped = 0
  const lifecycle = new ContainerLifecycle(async () => [])
  const starting = lifecycle.start(async () => {
    await startup
    return {
      stop: async () => {
        stopped += 1
      }
    }
  })

  const cleaning = lifecycle.cleanup()
  finishStartup?.()
  await starting
  await cleaning

  expect(stopped).toBe(1)
})
