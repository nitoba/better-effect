import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { describe, expect, test } from 'bun:test'

type ChildData = {
  readonly artifact?: string
  readonly kind?: string
  readonly status?: string
  readonly reason?: string
  readonly firstStatus?: string
  readonly secondStatus?: string
  readonly released?: number
  readonly backendDisposals?: number
  readonly sameError?: boolean
  readonly caught?: boolean
  readonly sameDefect?: boolean
  readonly cleanupObserved?: boolean
  readonly cleanupCauseIdentity?: boolean
  readonly caughtCleanupIdentity?: boolean
  readonly caughtCleanupClass?: string
  readonly defectObserved?: boolean
  readonly successPolicyCalls?: number
  readonly calls?: number
  readonly sigintListeners?: number
  readonly sigtermListeners?: number
  readonly exitCode?: number | null
  readonly processExitCalled?: boolean
}

type ChildResult = {
  readonly code: number | null
  readonly signal: string | null
  readonly data: ChildData
  readonly output: string
}

type ChildTarget = {
  readonly name: string
  readonly command: string
  readonly artifact: 'source' | 'fresh-packed'
  readonly runtimeEntry: string
  readonly coreEntry: string
  readonly resultEntry?: string
  readonly packageDirectory?: string
}

const packageRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))
const childScript = resolve(packageRoot, 'tests/helpers/node-runtime-child.mjs')
const sourceRuntimeEntry = pathToFileURL(resolve(packageRoot, 'src/node.ts')).href
const sourceCoreEntry = pathToFileURL(resolve(packageRoot, 'src/index.ts')).href
const packedRuntimeEntry = process.env.BETTER_EFFECT_PACKED_RUNTIME_ENTRY
const packedCoreEntry = process.env.BETTER_EFFECT_PACKED_CORE_ENTRY
const packedResultEntry = process.env.BETTER_EFFECT_PACKED_RESULT_ENTRY
const packedPackageDirectory = process.env.BETTER_EFFECT_PACKED_PACKAGE_DIRECTORY
const packedEntries = [
  packedRuntimeEntry,
  packedCoreEntry,
  packedResultEntry,
  packedPackageDirectory
]

if (new Set(packedEntries.map((entry) => entry !== undefined)).size > 1) {
  throw new Error('Packed NodeRuntime test entries must be provided together')
}

const packedTarget: ChildTarget | undefined =
  packedRuntimeEntry !== undefined &&
  packedCoreEntry !== undefined &&
  packedResultEntry !== undefined &&
  packedPackageDirectory !== undefined
    ? {
        name: 'Bun (fresh packed package)',
        command: process.execPath,
        artifact: 'fresh-packed',
        runtimeEntry: packedRuntimeEntry,
        coreEntry: packedCoreEntry,
        resultEntry: packedResultEntry,
        packageDirectory: packedPackageDirectory
      }
    : undefined

const targets: readonly ChildTarget[] = packedTarget
  ? [
      packedTarget,
      {
        ...packedTarget,
        name: 'Node (fresh packed package)',
        command: 'node'
      }
    ]
  : [
      {
        name: 'Bun (source)',
        command: process.execPath,
        artifact: 'source',
        runtimeEntry: sourceRuntimeEntry,
        coreEntry: sourceCoreEntry
      }
    ]

const readChildResult = (output: string): ChildData => {
  const line = output
    .trim()
    .split(/\r?\n/)
    .reverse()
    .find((candidate) => candidate.startsWith('{'))

  if (!line) {
    throw new Error(`NodeRuntime child produced no JSON result:\n${output}`)
  }

  // SAFETY: the child helper emits one JSON object with the fields declared by ChildData.
  return JSON.parse(line) as ChildData
}

type ProcessSignal = 'SIGINT' | 'SIGTERM'

const hasLine = (output: string, line: string): boolean =>
  output.trim().split(/\r?\n/).includes(line)

const runChild = async (
  target: ChildTarget,
  scenario: string,
  signals: readonly ProcessSignal[] = []
): Promise<ChildResult> => {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    BETTER_EFFECT_RUNTIME_ENTRY: target.runtimeEntry,
    BETTER_EFFECT_CORE_ENTRY: target.coreEntry,
    BETTER_EFFECT_EXPECTED_ARTIFACT: target.artifact
  }

  if (target.resultEntry === undefined) {
    delete environment.BETTER_EFFECT_RESULT_ENTRY
  } else {
    environment.BETTER_EFFECT_RESULT_ENTRY = target.resultEntry
  }

  if (target.packageDirectory === undefined) {
    delete environment.BETTER_EFFECT_PACKED_PACKAGE_DIRECTORY
  } else {
    environment.BETTER_EFFECT_PACKED_PACKAGE_DIRECTORY = target.packageDirectory
  }

  const child = spawn(target.command, [childScript, scenario], {
    cwd: packageRoot,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  if (!child.stdout || !child.stderr) {
    throw new Error('NodeRuntime child streams were not piped')
  }

  let output = ''
  let errorOutput = ''
  let ready = false
  let resolveReady!: () => void
  let rejectReady!: (cause: Error) => void
  const readyPromise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise
    rejectReady = rejectPromise
  })

  const waitForLine = (line: string): Promise<void> => {
    if (hasLine(output, line)) {
      return Promise.resolve()
    }

    return new Promise<void>((resolveLine, rejectLine) => {
      const timeout = setTimeout(() => {
        child.stdout?.off('data', onData)
        rejectLine(new Error(`NodeRuntime child did not emit ${line}:\n${output}`))
      }, 5_000)
      const onData = (): void => {
        if (!hasLine(output, line)) {
          return
        }

        clearTimeout(timeout)
        child.stdout?.off('data', onData)
        resolveLine()
      }

      child.stdout?.on('data', onData)
    })
  }

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    output += chunk
    if (!ready && hasLine(output, 'READY')) {
      ready = true
      resolveReady()
    }
  })
  child.stderr.on('data', (chunk: string) => {
    errorOutput += chunk
  })
  child.once('error', (cause) => {
    if (!ready) {
      rejectReady(cause)
    }
  })

  if (signals.length > 0) {
    const readyTimeout = setTimeout(() => {
      rejectReady(new Error(`NodeRuntime child did not become ready:\n${errorOutput}`))
    }, 5_000)
    await readyPromise.finally(() => clearTimeout(readyTimeout))
    child.kill(signals[0]!)

    if (scenario === 'repeated-signal') {
      await waitForLine('ABORT_ACK')
      child.kill(signals[1]!)
    }
  }

  const result = await new Promise<{ code: number | null; signal: string | null }>(
    (resolveExit, rejectExit) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL')
        rejectExit(new Error(`NodeRuntime child timed out:\n${output}\n${errorOutput}`))
      }, 5_000)

      child.once('error', (cause) => {
        clearTimeout(timeout)
        rejectExit(cause)
      })
      child.once('close', (code, childSignal) => {
        clearTimeout(timeout)
        resolveExit({ code, signal: childSignal })
      })
    }
  )

  const data = readChildResult(output)

  if (data.artifact !== target.artifact) {
    throw new Error(
      `NodeRuntime child loaded ${String(data.artifact)} instead of ${target.artifact}:\n${output}`
    )
  }

  return {
    ...result,
    data,
    output: `${output}${errorOutput}`
  }
}

const expectNoProcessExit = (result: ChildResult): void => {
  expect(result.data.processExitCalled).toBe(false)
  expect(result.data.sigintListeners).toBe(0)
  expect(result.data.sigtermListeners).toBe(0)
}

for (const target of targets) {
  describe(`${target.name} NodeRuntime.runMain`, () => {
    test('disposes successful programs and removes listeners', async () => {
      const result = await runChild(target, 'success')

      expect(result.code).toBe(0)
      expect(result.signal).toBeNull()
      expect(result.data).toMatchObject({
        kind: 'success',
        status: 'ok',
        released: 1,
        exitCode: 0
      })
      expectNoProcessExit(result)
    })

    test('maps typed errors without replacing the exact error', async () => {
      const result = await runChild(target, 'typed-error')

      expect(result.code).toBe(7)
      expect(result.data).toMatchObject({
        kind: 'typed-error',
        status: 'error',
        sameError: true,
        released: 1,
        exitCode: 7
      })
      expectNoProcessExit(result)
    })

    test('keeps defects distinct and preserves cleanup', async () => {
      const result = await runChild(target, 'defect')

      expect(result.code).toBe(9)
      expect(result.data).toMatchObject({
        kind: 'defect',
        caught: true,
        sameDefect: true,
        released: 1,
        exitCode: 9
      })
      expectNoProcessExit(result)
    })

    test('gives cleanup failure precedence after success', async () => {
      const result = await runChild(target, 'cleanup')

      expect(result.code).toBe(1)
      expect(result.data).toMatchObject({
        kind: 'cleanup',
        caught: true,
        cleanupObserved: true,
        defectObserved: false,
        exitCode: 1
      })
      expectNoProcessExit(result)
    })

    test('preserves execution cleanup failures as cleanup, not defects', async () => {
      const result = await runChild(target, 'execution-cleanup')

      expect(result.code).toBe(1)
      expect(result.signal).toBeNull()
      expect(result.data).toMatchObject({
        kind: 'execution-cleanup',
        caught: true,
        cleanupObserved: true,
        cleanupCauseIdentity: true,
        caughtCleanupIdentity: true,
        caughtCleanupClass: 'ScopeCloseError',
        defectObserved: false,
        successPolicyCalls: 0,
        exitCode: 1
      })
      expectNoProcessExit(result)
    })

    test('does not leak listeners or exit policy across sequential calls', async () => {
      const result = await runChild(target, 'sequential')

      expect(result.code).toBe(6)
      expect(result.data).toMatchObject({
        kind: 'sequential',
        firstStatus: 'ok',
        secondStatus: 'error',
        exitCode: 6
      })
      expectNoProcessExit(result)
    })

    test('removes listeners when signal setup fails', async () => {
      const result = await runChild(target, 'setup')

      expect(result.code).toBe(8)
      expect(result.data).toMatchObject({
        kind: 'setup',
        caught: true,
        calls: 2,
        exitCode: 8
      })
      expectNoProcessExit(result)
    })

    test('validates signals before installing listeners', async () => {
      const result = await runChild(target, 'validation')

      expect(result.code).toBe(0)
      expect(result.data).toMatchObject({
        kind: 'validation',
        caught: true,
        exitCode: null,
        sigintListeners: 0,
        sigtermListeners: 0
      })
      expect(result.data.processExitCalled).toBe(false)
    })

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      test(`aborts and disposes exactly once on ${signal}`, async () => {
        const result = await runChild(target, 'signal', [signal])

        expect(result.code).toBe(0)
        expect(result.signal).toBeNull()
        expect(result.data).toMatchObject({
          kind: 'signal',
          status: 'ok',
          reason: signal,
          released: 1,
          exitCode: 0
        })
        expectNoProcessExit(result)
      })
    }

    test('preserves a typed error returned while handling a signal', async () => {
      const result = await runChild(target, 'signal-error', ['SIGTERM'])

      expect(result.code).toBe(7)
      expect(result.signal).toBeNull()
      expect(result.data).toMatchObject({
        kind: 'signal-error',
        status: 'error',
        sameError: true,
        exitCode: 7
      })
      expectNoProcessExit(result)
    })

    test('ignores a second signal after the first one is acknowledged', async () => {
      const result = await runChild(target, 'repeated-signal', ['SIGINT', 'SIGTERM'])

      expect(result.code).toBe(0)
      expect(result.signal).toBeNull()
      expect(result.data).toMatchObject({
        kind: 'repeated-signal',
        status: 'ok',
        reason: 'SIGINT',
        released: 1,
        backendDisposals: 1,
        exitCode: 0
      })
      expectNoProcessExit(result)
    })
  })
}
