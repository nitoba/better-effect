import { describe, expect, test } from 'bun:test'

import { Result } from 'better-result'

import { CurrentAbortSignal, Effect, Layer, Runtime } from '../src'

describe('cooperative Runtime cancellation', () => {
  test('links a run signal and exposes it through CurrentAbortSignal', async () => {
    const runtime = await Runtime.make(Layer.merge())
    const controller = new AbortController()
    let observedSignal: AbortSignal | undefined

    try {
      const result = await runtime.run(
        Effect.fn(async function* () {
          observedSignal = yield* CurrentAbortSignal
          expect(observedSignal.aborted).toBe(false)

          controller.abort()

          return Result.ok(observedSignal.aborted)
        }),
        { signal: controller.signal }
      )

      expect(Result.isOk(result)).toBe(true)
      expect(observedSignal).toBeDefined()

      if (Result.isOk(result)) {
        expect(result.value).toBe(true)
      }
    } finally {
      await runtime.dispose()
    }
  })

  test('aborts active executions after the configured grace period', async () => {
    const runtime = await Runtime.make(Layer.merge())
    let markStarted!: () => void
    let markAborted!: () => void

    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const aborted = new Promise<void>((resolve) => {
      markAborted = resolve
    })

    const execution = runtime.run(
      Effect.fn(async function* () {
        const signal = yield* CurrentAbortSignal
        markStarted()

        await new Promise<void>((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              markAborted()
              resolve()
            },
            { once: true }
          )
        })

        return Result.ok(signal.aborted)
      })
    )

    await started

    const disposal = runtime.dispose({
      gracePeriod: 10,
      abortAfterGracePeriod: true
    })

    await aborted
    await disposal

    const result = await execution
    expect(Result.isOk(result)).toBe(true)

    if (Result.isOk(result)) {
      expect(result.value).toBe(true)
    }
  })

  test('rejects invalid shutdown grace periods', async () => {
    const runtime = await Runtime.make(Layer.merge())

    expect(() => runtime.dispose({ gracePeriod: -1 })).toThrow(
      'Runtime dispose gracePeriod must be a finite non-negative number'
    )

    await runtime.dispose()
  })
})
