import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))
const assertCondition: (condition: boolean, message: string) => asserts condition = (
  condition,
  message
) => {
  if (!condition) {
    throw new Error(message)
  }
}

const run = async (command: readonly string[], cwd: string): Promise<void> => {
  const child = Bun.spawn([...command], {
    cwd,
    stdout: 'inherit',
    stderr: 'inherit'
  })
  const exitCode = await child.exited

  if (exitCode !== 0) {
    throw new Error(`Command failed with exit code ${exitCode}: ${command.join(' ')}`)
  }
}

const runCapture = async (
  command: readonly string[],
  cwd: string
): Promise<{ readonly exitCode: number; readonly output: string }> => {
  const child = Bun.spawn([...command], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ])

  return { exitCode, output: `${stdout}\n${stderr}` }
}

const copyDependency = async (
  consumerNodeModules: string,
  dependency: string,
  source: string
): Promise<void> => {
  const destination = join(consumerNodeModules, dependency)
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, { dereference: true, recursive: true })
}

const createConsumer = async (
  root: string,
  archive: string,
  includeOtel: boolean
): Promise<string> => {
  const consumer = join(root, includeOtel ? 'with-peer' : 'without-peer')
  const nodeModules = join(consumer, 'node_modules')
  const packageDirectory = join(nodeModules, 'better-effect')

  await mkdir(nodeModules, { recursive: true })
  await writeFile(join(consumer, 'package.json'), '{"type":"module"}\n')
  await run(['tar', '-xzf', archive, '-C', nodeModules], packageRoot)
  await rename(join(nodeModules, 'package'), packageDirectory)

  const betterResult = await realpath(join(packageRoot, 'node_modules/better-result'))
  await copyDependency(nodeModules, 'better-result', betterResult)

  if (includeOtel) {
    const otelApi = await realpath(join(packageRoot, 'node_modules/@opentelemetry/api'))
    await copyDependency(nodeModules, '@opentelemetry/api', otelApi)
  }

  return consumer
}

const packageArchive = async (directory: string): Promise<string> => {
  const archive = (await readdir(directory)).find(
    (entry) => entry.startsWith('better-effect-') && entry.endsWith('.tgz')
  )

  if (archive === undefined) {
    throw new Error('OpenTelemetry package archive was not created')
  }

  return join(directory, archive)
}

const mainConsumerSource = `
import { Layer, Runtime } from 'better-effect'
import { Result } from 'better-result'

const runtime = await Runtime.make(Layer.empty)
const result = await runtime.run(() => Result.ok('main-without-otel'))
await runtime.dispose()

if (!Result.isOk(result) || result.value !== 'main-without-otel') {
  throw new Error('main entrypoint failed without OpenTelemetry')
}
`

const missingOtelSource = `
await import('better-effect/opentelemetry')
`

const otelConsumerSource = `
import { trace } from '@opentelemetry/api'
import { Layer, Runtime } from 'better-effect'
import { OpenTelemetryRuntimeObserver } from 'better-effect/opentelemetry'
import { Result } from 'better-result'

const observer = OpenTelemetryRuntimeObserver.make({ tracer: trace.getTracer('consumer') })
const runtime = await Runtime.make(Layer.empty, { observers: [observer] })
const result = await runtime.run(() => Result.ok('otel-peer'))
await runtime.dispose()

if (!Result.isOk(result) || result.value !== 'otel-peer') {
  throw new Error('OpenTelemetry subpath failed with its peer installed')
}
`

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'better-effect-opentelemetry-'))

try {
  const archiveDirectory = join(temporaryDirectory, 'archive')
  await mkdir(archiveDirectory, { recursive: true })
  await run(
    [process.execPath, 'pm', 'pack', '--destination', archiveDirectory, '--ignore-scripts'],
    packageRoot
  )
  const archive = await packageArchive(archiveDirectory)
  const listing = await runCapture(['tar', '-tzf', archive], packageRoot)

  assertCondition(listing.exitCode === 0, `Could not inspect package archive:\n${listing.output}`)
  for (const path of [
    'package/dist/index.mjs',
    'package/dist/opentelemetry.mjs',
    'package/dist/opentelemetry.d.mts',
    'package/package.json'
  ]) {
    assertCondition(listing.output.split('\n').includes(path), `Archive is missing ${path}`)
  }

  for (const entry of ['dist/index.mjs', 'dist/testing.mjs']) {
    const source = await readFile(join(packageRoot, entry), 'utf8')
    assertCondition(!source.includes('@opentelemetry/api'), `${entry} loads OpenTelemetry`)
  }

  const withoutPeer = await createConsumer(temporaryDirectory, archive, false)
  await writeFile(join(withoutPeer, 'main.mjs'), mainConsumerSource)
  await writeFile(join(withoutPeer, 'missing-otel.mjs'), missingOtelSource)
  await run(['node', 'main.mjs'], withoutPeer)
  const missingPeer = await runCapture(['node', 'missing-otel.mjs'], withoutPeer)
  assertCondition(
    missingPeer.exitCode !== 0 && missingPeer.output.includes('@opentelemetry/api'),
    'OpenTelemetry subpath unexpectedly worked without its optional peer'
  )

  const withPeer = await createConsumer(temporaryDirectory, archive, true)
  await writeFile(join(withPeer, 'otel.mjs'), otelConsumerSource)
  await run(['node', 'otel.mjs'], withPeer)
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}

console.log('Packed OpenTelemetry optional-peer checks passed')
