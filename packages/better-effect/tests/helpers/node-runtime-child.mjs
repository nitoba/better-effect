import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const runtimeEntry = process.env.BETTER_EFFECT_RUNTIME_ENTRY
const coreEntry = process.env.BETTER_EFFECT_CORE_ENTRY
const resultEntry = process.env.BETTER_EFFECT_RESULT_ENTRY ?? 'better-result'
const artifact = process.env.BETTER_EFFECT_EXPECTED_ARTIFACT ?? 'source'
const packedPackageDirectory = process.env.BETTER_EFFECT_PACKED_PACKAGE_DIRECTORY

if (!runtimeEntry || !coreEntry) {
  throw new Error('NodeRuntime child entries are required')
}

const assertEntry = (entry, expectedPath, label) => {
  let actualPath

  try {
    actualPath = fileURLToPath(new URL(entry))
  } catch {
    throw new Error(`${label} is not a file URL: ${entry}`)
  }

  if (resolve(actualPath) !== resolve(expectedPath)) {
    throw new Error(`${label} did not load the fresh packed artifact: ${entry}`)
  }
}

if (artifact === 'fresh-packed') {
  if (!packedPackageDirectory) {
    throw new Error('Fresh packed NodeRuntime tests require a package directory')
  }

  assertEntry(runtimeEntry, resolve(packedPackageDirectory, 'dist/node.mjs'), 'NodeRuntime entry')
  assertEntry(coreEntry, resolve(packedPackageDirectory, 'dist/index.mjs'), 'core entry')
  assertEntry(
    resultEntry,
    resolve(packedPackageDirectory, '../better-result/dist/index.mjs'),
    'Result entry'
  )
} else if (packedPackageDirectory) {
  throw new Error('Source NodeRuntime tests cannot provide a packed package directory')
}

const [{ NodeRuntime }, core, { Result }] = await Promise.all([
  import(runtimeEntry),
  import(coreEntry),
  import(resultEntry)
])

const { CurrentAbortSignal, Effect, Layer, MapLayerBackend, Service, ServiceRuntime } = core
const scenario = process.argv[2]
const keepAlive =
  scenario === 'signal' || scenario === 'signal-error' || scenario === 'repeated-signal'
    ? setInterval(() => {}, 1_000)
    : undefined
let processExitCalled = false
const originalExit = process.exit

process.exit = (...args) => {
  processExitCalled = true
  throw new Error(`process.exit called with ${String(args[0])}`)
}

const print = (value) => {
  process.stdout.write(`${JSON.stringify({ ...value, artifact, processExitCalled })}\n`)
}

class ChildService extends Service()(`ChildService:${scenario}`) {}

const makeLayer = (release = () => {}) =>
  Layer.scoped(ChildService, () => new ChildService(), release)

try {
  if (scenario === 'success') {
    let released = 0
    const result = await NodeRuntime.runMain(
      makeLayer(() => {
        released += 1
      }),
      Effect.fn(async function* () {
        yield* ChildService
        return Result.ok('success')
      })
    )

    print({
      kind: 'success',
      status: result.status,
      released,
      sigintListeners: process.listenerCount('SIGINT'),
      sigtermListeners: process.listenerCount('SIGTERM'),
      exitCode: process.exitCode ?? null
    })
  } else if (scenario === 'typed-error') {
    let released = 0
    const error = { code: 'typed-error' }
    let sameError = false
    const result = await NodeRuntime.runMain(
      makeLayer(() => {
        released += 1
      }),
      async () => {
        await ServiceRuntime.resolve(ChildService)
        return Result.err(error)
      },
      {
        onFailure: (received) => {
          sameError = received === error
          return 7
        }
      }
    )

    print({
      kind: 'typed-error',
      status: result.status,
      sameError,
      released,
      sigintListeners: process.listenerCount('SIGINT'),
      sigtermListeners: process.listenerCount('SIGTERM'),
      exitCode: process.exitCode ?? null
    })
  } else if (scenario === 'defect') {
    let released = 0
    const defect = new Error('child defect')
    let sameDefect = false
    let caught = false

    try {
      await NodeRuntime.runMain(
        makeLayer(() => {
          released += 1
        }),
        async () => {
          await ServiceRuntime.resolve(ChildService)
          throw defect
        },
        {
          onDefect: (cause) => {
            sameDefect = cause === defect
            return 9
          }
        }
      )
    } catch (cause) {
      caught = cause === defect
    }

    print({
      kind: 'defect',
      caught,
      sameDefect,
      released,
      sigintListeners: process.listenerCount('SIGINT'),
      sigtermListeners: process.listenerCount('SIGTERM'),
      exitCode: process.exitCode ?? null
    })
  } else if (scenario === 'cleanup') {
    let cleanupObserved = false
    let defectObserved = false
    let caught = false

    try {
      await NodeRuntime.runMain(
        makeLayer(() => {
          throw new Error('child cleanup')
        }),
        Effect.fn(async function* () {
          yield* ChildService
          return Result.ok('success-before-cleanup')
        }),
        {
          onCleanupFailure: (diagnostic) => {
            cleanupObserved = diagnostic.error instanceof Error
          },
          onDefect: () => {
            defectObserved = true
            return 0
          }
        }
      )
    } catch (cause) {
      caught = cause instanceof Error
    }

    print({
      kind: 'cleanup',
      caught,
      cleanupObserved,
      defectObserved,
      sigintListeners: process.listenerCount('SIGINT'),
      sigtermListeners: process.listenerCount('SIGTERM'),
      exitCode: process.exitCode ?? null
    })
  } else if (scenario === 'execution-cleanup') {
    const cleanupFailure = new Error('execution cleanup')
    let observedCleanupError
    let cleanupObserved = false
    let cleanupCauseIdentity = false
    let caughtCleanupIdentity = false
    let caughtCleanupClass
    let defectObserved = false
    let successPolicyCalls = 0
    let caught = false

    try {
      await NodeRuntime.runMain(
        Layer.empty,
        Effect.fn(async function* () {
          yield* Effect.acquireRelease(
            () => ({ value: true }),
            () => {
              throw cleanupFailure
            }
          )
          return Result.ok('success-before-execution-cleanup')
        }),
        {
          signals: [],
          onSuccess: () => {
            successPolicyCalls += 1
            return 0
          },
          onCleanupFailure: (diagnostic) => {
            observedCleanupError = diagnostic.error
            cleanupObserved = diagnostic.outcome.status === 'success'
            cleanupCauseIdentity = diagnostic.error.causes[0] === cleanupFailure
          },
          onDefect: () => {
            defectObserved = true
            return 9
          }
        }
      )
    } catch (cause) {
      caught = true
      caughtCleanupIdentity = cause === observedCleanupError
      caughtCleanupClass = cause?.name
      cleanupCauseIdentity = cleanupCauseIdentity && cause?.causes?.[0] === cleanupFailure
    }

    print({
      kind: 'execution-cleanup',
      caught,
      cleanupObserved,
      cleanupCauseIdentity,
      caughtCleanupIdentity,
      caughtCleanupClass,
      defectObserved,
      successPolicyCalls,
      sigintListeners: process.listenerCount('SIGINT'),
      sigtermListeners: process.listenerCount('SIGTERM'),
      exitCode: process.exitCode ?? null
    })
  } else if (scenario === 'signal-error') {
    const error = { code: 'signal-error' }
    let sameError = false
    const result = await NodeRuntime.runMain(
      makeLayer(),
      Effect.fn(async function* () {
        const signal = yield* CurrentAbortSignal
        process.stdout.write('READY\n')
        await new Promise((resolve) => {
          if (signal.aborted) {
            resolve()
          } else {
            signal.addEventListener('abort', resolve, { once: true })
          }
        })
        return Result.err(error)
      }),
      {
        onFailure: (received) => {
          sameError = received === error
          return 7
        }
      }
    )

    print({
      kind: 'signal-error',
      status: result.status,
      sameError,
      sigintListeners: process.listenerCount('SIGINT'),
      sigtermListeners: process.listenerCount('SIGTERM'),
      exitCode: process.exitCode ?? null
    })
  } else if (scenario === 'signal') {
    let released = 0
    const result = await NodeRuntime.runMain(
      makeLayer(() => {
        released += 1
      }),
      Effect.fn(async function* () {
        await ServiceRuntime.resolve(ChildService)
        const signal = yield* CurrentAbortSignal
        process.stdout.write('READY\n')
        await new Promise((resolve) => {
          if (signal.aborted) {
            resolve()
          } else {
            signal.addEventListener('abort', resolve, { once: true })
          }
        })
        return Result.ok(signal.reason)
      }),
      { onSuccess: () => 0 }
    )

    print({
      kind: 'signal',
      status: result.status,
      reason: result.value,
      released,
      sigintListeners: process.listenerCount('SIGINT'),
      sigtermListeners: process.listenerCount('SIGTERM'),
      exitCode: process.exitCode ?? null
    })
  } else if (scenario === 'repeated-signal') {
    let released = 0
    let backendDisposals = 0
    const backend = new MapLayerBackend()
    const disposeAll = backend.disposeAll.bind(backend)
    backend.disposeAll = async (...args) => {
      backendDisposals += 1
      return await disposeAll(...args)
    }
    const result = await NodeRuntime.runMain(
      makeLayer(() => {
        released += 1
      }),
      backend,
      Effect.fn(async function* () {
        await ServiceRuntime.resolve(ChildService)
        const signal = yield* CurrentAbortSignal
        process.stdout.write('READY\n')
        await new Promise((resolve) => {
          const finish = () => {
            process.stdout.write('ABORT_ACK\n')
            setTimeout(resolve, 100)
          }

          if (signal.aborted) {
            finish()
          } else {
            signal.addEventListener('abort', finish, { once: true })
          }
        })
        return Result.ok(signal.reason)
      }),
      { signals: ['SIGINT', 'SIGTERM'], onSuccess: () => 0 }
    )

    print({
      kind: 'repeated-signal',
      status: result.status,
      reason: result.value,
      released,
      backendDisposals,
      sigintListeners: process.listenerCount('SIGINT'),
      sigtermListeners: process.listenerCount('SIGTERM'),
      exitCode: process.exitCode ?? null
    })
  } else if (scenario === 'sequential') {
    const first = await NodeRuntime.runMain(Layer.empty, () => Result.ok('first'), {
      signals: [],
      onSuccess: () => 0
    })
    const second = await NodeRuntime.runMain(Layer.empty, () => Result.err('second'), {
      signals: [],
      onFailure: (error) => (error === 'second' ? 6 : 1)
    })

    print({
      kind: 'sequential',
      firstStatus: first.status,
      secondStatus: second.status,
      sigintListeners: process.listenerCount('SIGINT'),
      sigtermListeners: process.listenerCount('SIGTERM'),
      exitCode: process.exitCode ?? null
    })
  } else if (scenario === 'setup') {
    const originalOn = process.on
    let calls = 0
    let caught = false

    process.on = function (event, listener) {
      calls += 1
      if (event === 'SIGTERM') {
        throw new Error('child listener setup')
      }
      return originalOn.call(this, event, listener)
    }

    try {
      await NodeRuntime.runMain(Layer.empty, () => Result.ok('unreachable'), {
        onDefect: () => 8
      })
    } catch {
      caught = true
    } finally {
      process.on = originalOn
    }

    print({
      kind: 'setup',
      caught,
      calls,
      sigintListeners: process.listenerCount('SIGINT'),
      sigtermListeners: process.listenerCount('SIGTERM'),
      exitCode: process.exitCode ?? null
    })
  } else if (scenario === 'validation') {
    let caught = false

    try {
      await NodeRuntime.runMain(Layer.empty, () => Result.ok('unreachable'), {
        signals: ['NOT_A_SIGNAL']
      })
    } catch {
      caught = true
    }

    print({
      kind: 'validation',
      caught,
      sigintListeners: process.listenerCount('SIGINT'),
      sigtermListeners: process.listenerCount('SIGTERM'),
      exitCode: process.exitCode ?? null
    })
  } else {
    throw new Error(`Unknown scenario: ${scenario}`)
  }
} finally {
  if (keepAlive) {
    clearInterval(keepAlive)
  }
  process.exit = originalExit
}
