import { describe, expect, test } from 'bun:test'

import { Result } from 'better-result'

import { Layer, Runtime, Service, ServiceRuntime } from '../src'
import { Scope, ScopeCloseError, type ScopeOutcome } from '../src/scope'

const captureRejection = async (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (cause) => cause
  )

class ProxyResource extends Service<ProxyResource>()('ProxyResource') {}

describe('Runtime outcome classification', () => {
  test('treats ordinary status-error domain values as successful', async () => {
    const runtime = await Runtime.make(Layer.merge())
    const domainValue = { status: 'error' as const, error: 'domain failure' }
    let observed: ScopeOutcome | undefined

    try {
      const result = await runtime.run(async () => {
        Scope.current().addFinalizer((outcome) => {
          observed = outcome
        })

        return domainValue
      })

      expect(result).toBe(domainValue)
      expect(observed).toEqual({ status: 'success' })
    } finally {
      await runtime.dispose()
    }
  })

  test('classifies a nominal better-result Err as a failed outcome', async () => {
    const runtime = await Runtime.make(Layer.merge())
    const error = new Error('domain failure')
    const expected = Result.err(error)
    let observed: ScopeOutcome | undefined

    try {
      const result = await runtime.run(async () => {
        Scope.current().addFinalizer((outcome) => {
          observed = outcome
        })

        return expected
      })

      expect(result).toBe(expected)
      expect(observed).toEqual({ status: 'failure', cause: error })
    } finally {
      await runtime.dispose()
    }
  })

  test('turns classifier inspection failures into primary failures after cleanup', async () => {
    const diagnostics: Array<{ outcome: ScopeOutcome; error: ScopeCloseError }> = []
    const runtime = await Runtime.make(Layer.merge(), {
      onCleanupFailure: (diagnostic) => {
        if (diagnostic.error instanceof ScopeCloseError) {
          diagnostics.push(diagnostic)
        }
      }
    })
    const inspectionFailure = new Error('prototype inspection failed')
    const cleanupFailure = new Error('execution cleanup failed')
    let releases = 0
    const value = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw inspectionFailure
        }
      }
    )

    try {
      const failure = await captureRejection(
        runtime.run(async () => {
          Scope.current().addFinalizer(() => {
            releases++
            throw cleanupFailure
          })

          return value
        })
      )

      expect(failure).toBe(inspectionFailure)
      expect(releases).toBe(1)
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]?.outcome).toEqual({
        status: 'failure',
        cause: inspectionFailure
      })
      expect(diagnostics[0]?.error.causes).toEqual([cleanupFailure])
    } finally {
      await runtime.dispose()
    }
  })

  test('reuses the classified outcome for observers after execution cleanup', async () => {
    const inspectionFailure = new Error('value inspected twice')
    const executionOutcomes: ScopeOutcome[] = []
    let inspections = 0
    let cleaned = false
    let cleanupOutcome: ScopeOutcome | undefined
    const value = new Proxy(
      {},
      {
        getPrototypeOf() {
          inspections++

          if (inspections > 1) {
            throw inspectionFailure
          }

          return Object.prototype
        }
      }
    )
    const runtime = await Runtime.make(Layer.merge(), {
      observers: [
        {
          onExecutionEnd: ({ outcome }) => {
            executionOutcomes.push(outcome)
          }
        }
      ]
    })

    try {
      const result = await runtime.run(async () => {
        Scope.current().addFinalizer((outcome) => {
          cleaned = true
          cleanupOutcome = outcome
        })

        return value
      })

      expect(result).toBe(value)
      expect(cleaned).toBe(true)
      expect(inspections).toBe(1)
      expect(executionOutcomes).toHaveLength(1)
      expect(executionOutcomes[0]).toEqual({ status: 'success' })
      expect(cleanupOutcome).toBe(executionOutcomes[0])
    } finally {
      await runtime.dispose()
    }
  })

  test('classifies one-shot values once for observers and root cleanup', async () => {
    const inspectionFailure = new Error('value inspected twice')
    const executionOutcomes: ScopeOutcome[] = []
    let rootOutcome: ScopeOutcome | undefined
    let inspections = 0
    const value = new Proxy(
      {},
      {
        getPrototypeOf() {
          inspections++

          if (inspections > 1) {
            throw inspectionFailure
          }

          return Object.prototype
        }
      }
    )

    const result = await Runtime.run(
      Layer.scoped(
        ProxyResource,
        () => new ProxyResource(),
        (_resource, outcome) => {
          rootOutcome = outcome
        }
      ),
      async () => {
        await ServiceRuntime.resolve(ProxyResource)
        return value
      },
      {
        observers: [
          {
            onExecutionEnd: ({ outcome }) => {
              executionOutcomes.push(outcome)
            }
          }
        ]
      }
    )

    expect(result).toBe(value)
    expect(inspections).toBe(1)
    expect(executionOutcomes).toHaveLength(1)
    expect(executionOutcomes[0]).toEqual({ status: 'success' })
    expect(rootOutcome).toBe(executionOutcomes[0])
  })
})
