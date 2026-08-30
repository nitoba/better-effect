import { describe, expect, test } from 'bun:test'

import { Result } from 'better-result'

import { CurrentAbortSignal, CurrentRuntimeAbortSignal, Effect, Layer, Runtime } from '../src'

describe('cooperative Runtime cancellation', () => {
  test('preserves a run signal identity through CurrentAbortSignal', async () => {
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
      expect(observedSignal).toBe(controller.signal)

      if (Result.isOk(result)) {
        expect(result.value).toBe(true)
      }
    } finally {
      await runtime.dispose()
    }
  })

  test('keeps Runtime shutdown cancellation separate from a caller signal', async () => {
    const runtime = await Runtime.make(Layer.merge())
    const caller = new AbortController()
    let markStarted!: () => void

    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })

    const execution = runtime.run(
      Effect.fn(async function* () {
        const callerSignal = yield* CurrentAbortSignal
        const runtimeSignal = yield* CurrentRuntimeAbortSignal
        expect(callerSignal).toBe(caller.signal)
        expect(runtimeSignal).not.toBe(callerSignal)
        markStarted()

        await new Promise<void>((resolve) => {
          runtimeSignal.addEventListener('abort', () => resolve(), { once: true })
        })

        return Result.ok({
          callerAborted: callerSignal.aborted,
          runtimeAborted: runtimeSignal.aborted
        })
      }),
      { signal: caller.signal }
    )

    await started

    try {
      await runtime.dispose({
        gracePeriod: 0,
        abortAfterGracePeriod: true
      })

      const result = await execution
      expect(Result.isOk(result)).toBe(true)

      if (Result.isOk(result)) {
        expect(result.value).toEqual({ callerAborted: false, runtimeAborted: true })
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
