const runtimeEntry = process.env.BETTER_EFFECT_RUNTIME_ENTRY
const coreEntry = process.env.BETTER_EFFECT_CORE_ENTRY

if (!runtimeEntry || !coreEntry) {
  throw new Error('NodeRuntime child entries are required')
}

const [{ NodeRuntime }, core, { Result }] = await Promise.all([
  import(runtimeEntry),
  import(coreEntry),
  import('better-result')
])

const { CurrentAbortSignal, Effect, Layer, Service, ServiceRuntime } = core
const scenario = process.argv[2]
const keepAlive =
  scenario === 'signal' || scenario === 'signal-error' ? setInterval(() => {}, 1_000) : undefined
let processExitCalled = false
const originalExit = process.exit

process.exit = (...args) => {
  processExitCalled = true
  throw new Error(`process.exit called with ${String(args[0])}`)
}

const print = (value) => {
  process.stdout.write(`${JSON.stringify({ ...value, processExitCalled })}\n`)
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
