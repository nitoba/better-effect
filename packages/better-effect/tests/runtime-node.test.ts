import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { describe, expect, test } from 'bun:test'

type ChildData = {
  readonly kind?: string
  readonly status?: string
  readonly reason?: string
  readonly firstStatus?: string
  readonly secondStatus?: string
  readonly released?: number
  readonly sameError?: boolean
  readonly caught?: boolean
  readonly sameDefect?: boolean
  readonly cleanupObserved?: boolean
  readonly defectObserved?: boolean
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
  readonly runtimeEntry: string
  readonly coreEntry: string
}

const packageRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))
const childScript = resolve(packageRoot, 'tests/helpers/node-runtime-child.mjs')
const sourceRuntimeEntry = pathToFileURL(resolve(packageRoot, 'src/node.ts')).href
const sourceCoreEntry = pathToFileURL(resolve(packageRoot, 'src/index.ts')).href
const distRuntimePath = resolve(packageRoot, 'dist/node.mjs')
const distCorePath = resolve(packageRoot, 'dist/index.mjs')

const targets: readonly ChildTarget[] = [
  {
    name: 'Bun',
    command: process.execPath,
    runtimeEntry: sourceRuntimeEntry,
    coreEntry: sourceCoreEntry
  },
  ...(existsSync(distRuntimePath)
    ? [
        {
          name: 'Node',
          command: 'node',
          runtimeEntry: pathToFileURL(distRuntimePath).href,
          coreEntry: pathToFileURL(distCorePath).href
        }
      ]
    : [])
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

const runChild = async (
  target: ChildTarget,
  scenario: string,
  signal?: 'SIGINT' | 'SIGTERM'
): Promise<ChildResult> => {
  const child = spawn(target.command, [childScript, scenario], {
    cwd: packageRoot,
    env: {
      ...process.env,
      BETTER_EFFECT_RUNTIME_ENTRY: target.runtimeEntry,
      BETTER_EFFECT_CORE_ENTRY: target.coreEntry
    },
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

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    output += chunk
    if (!ready && output.split(/\r?\n/).includes('READY')) {
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

  if (signal) {
    const readyTimeout = setTimeout(() => {
      rejectReady(new Error(`NodeRuntime child did not become ready:\n${errorOutput}`))
    }, 5_000)
    await readyPromise.finally(() => clearTimeout(readyTimeout))
    child.kill(signal)
    child.kill(signal)
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

  return {
    ...result,
    data: readChildResult(output),
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
        const result = await runChild(target, 'signal', signal)

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
      const result = await runChild(target, 'signal-error', 'SIGTERM')

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
  })
}
