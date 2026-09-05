import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('../..', import.meta.url))
const corePackageRoot = join(packageRoot, '../better-effect')
const fixtureSource = join(packageRoot, 'tests/package/consumer')
const decoder = new TextDecoder()

const assertCondition: (condition: boolean, message: string) => asserts condition = (
  condition,
  message
) => {
  if (!condition) {
    throw new Error(message)
  }
}

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonValue[] | JsonObject
type JsonObject = { readonly [key: string]: JsonValue }

const isJsonObject = (value: JsonValue): value is JsonObject =>
  Object.prototype.toString.call(value) === '[object Object]'

type CommandResult = {
  exitCode: number
  output: string
}

const run = (command: string[], cwd: string): CommandResult => {
  const result = Bun.spawnSync(command, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe'
  })

  return {
    exitCode: result.exitCode,
    output: `${decoder.decode(result.stdout)}\n${decoder.decode(result.stderr)}`
  }
}

const assertSuccess = (result: CommandResult, description: string): void => {
  assertCondition(
    result.exitCode === 0,
    `${description} failed with exit code ${result.exitCode}:\n${result.output}`
  )
}

const makeFixture = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'better-effect-mq-consumer-'))
  const fixture = join(root, 'consumer')

  await cp(fixtureSource, fixture, { recursive: true })

  return root
}

const ensureBuild = (root: string, name: string): void => {
  const result = run(['bun', 'run', 'build'], root)
  assertSuccess(result, `Building ${name}`)
}

const pack = async (root: string, packageRootToPack: string, name: string): Promise<string> => {
  const destination = join(root, `pack-${name}`)
  await mkdir(destination)
  ensureBuild(packageRootToPack, name)

  const result = run(
    ['bun', 'pm', 'pack', '--destination', destination, '--ignore-scripts'],
    packageRootToPack
  )
  assertSuccess(result, `Packing ${name}`)

  const archives = (await readdir(destination)).filter((entry) => entry.endsWith('.tgz'))
  assertCondition(archives.length === 1, `Expected one ${name} archive, found ${archives.length}`)

  const archive = archives[0]
  assertCondition(archive !== undefined, `${name} archive name was not returned`)

  return join(destination, archive)
}

const archiveEntries = (archive: string): string[] => {
  const result = run(['tar', '-tzf', archive], packageRoot)
  assertSuccess(result, 'Listing the package archive')

  return result.output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

const assertArchiveContents = (entries: string[], name: string): void => {
  const entrySet = new Set(entries)
  const required = [
    'package/package.json',
    'package/LICENSE',
    'package/README.md',
    ...(name === 'better-effect-mq' ? ['package/CHANGELOG.md'] : []),
    ...(name === 'better-effect-mq'
      ? [
          'package/docs/writing-a-driver.md',
          'package/docs/protocol/job-store-v1.md',
          'package/docs/protocol/state-machine-v1.md',
          'package/docs/protocol/operation-atomicity-v1.md',
          'package/docs/protocol/errors-v1.md',
          'package/docs/protocol/cursors-and-ordering-v1.md',
          'package/docs/protocol/time-and-leases-v1.md',
          'package/docs/protocol/capabilities-v1.md',
          'package/docs/protocol/compatibility-v1.md'
        ]
      : []),
    'package/dist/index.mjs',
    'package/dist/index.d.mts'
  ]

  if (name === 'better-effect-mq') {
    required.push('package/dist/testing.mjs', 'package/dist/testing.d.mts')
  } else {
    required.push('package/dist/standard-services.mjs', 'package/dist/standard-services.d.mts')
  }

  for (const entry of required) {
    assertCondition(entrySet.has(entry), `${name} archive is missing ${entry}`)
  }

  assertCondition(
    !entries.some(
      (entry) => entry.startsWith('package/src/') || entry.startsWith('package/tests/')
    ),
    `${name} archive contains development source or tests`
  )
}

const installPeerDependencies = (fixture: string): void => {
  const result = run(['bun', 'install', '--ignore-scripts', '--no-save'], fixture)
  assertSuccess(result, 'Installing the better-effect and better-result peer dependencies')
}

const installArchive = async (
  archive: string,
  fixture: string,
  packageName: string
): Promise<string> => {
  const nodeModules = join(fixture, 'node_modules')
  const installedPackage = join(nodeModules, packageName)

  await mkdir(nodeModules, { recursive: true })
  await rm(installedPackage, { recursive: true, force: true })
  const result = run(['tar', '-xzf', archive, '-C', nodeModules], fixture)
  assertSuccess(result, `Extracting the ${packageName} archive`)
  await rename(join(nodeModules, 'package'), installedPackage)

  return installedPackage
}

const assertPackedManifest = async (
  installedPackage: string,
  packageName: string
): Promise<void> => {
  const value: JsonValue = JSON.parse(
    await readFile(join(installedPackage, 'package.json'), 'utf8')
  )

  assertCondition(isJsonObject(value), `${packageName} metadata must be an object`)

  assertCondition(value['name'] === packageName, `${packageName} archive has the wrong name`)
  assertCondition(value['type'] === 'module', `${packageName} archive is not ESM`)
}

const typecheckFixture = (fixture: string): void => {
  const tsconfig = join(fixture, 'tsconfig.json')
  const current = run(
    ['bun', 'run', '--silent', 'tsc', '--', '-p', tsconfig, '--pretty', 'false'],
    packageRoot
  )
  assertSuccess(current, 'External fixture typecheck with the project TypeScript')
}

const smokeWith = (runtime: 'bun' | 'node', fixture: string): void => {
  const result = run([runtime, 'smoke.mjs'], fixture)
  assertSuccess(result, `External consumer smoke test with ${runtime}`)
}

const assertNodeLts = (): void => {
  const result = run(['node', '--version'], packageRoot)
  assertSuccess(result, 'Checking the Node.js runtime')
  const major = /^v(\d+)\./u.exec(result.output.trim())?.[1]
  assertCondition(
    major !== undefined && Number(major) >= 24,
    'The external Node smoke test requires the current Node.js LTS (24 or newer)'
  )
}

const main = async (): Promise<void> => {
  assertNodeLts()
  const root = await makeFixture()

  try {
    const coreArchive = await pack(root, corePackageRoot, 'better-effect')
    const mqArchive = await pack(root, packageRoot, 'better-effect-mq')
    assertArchiveContents(archiveEntries(coreArchive), 'better-effect')
    assertArchiveContents(archiveEntries(mqArchive), 'better-effect-mq')
    const fixture = join(root, 'consumer')
    installPeerDependencies(fixture)
    const installedCore = await installArchive(coreArchive, fixture, 'better-effect')
    const installedMq = await installArchive(mqArchive, fixture, 'better-effect-mq')

    await assertPackedManifest(installedCore, 'better-effect')
    await assertPackedManifest(installedMq, 'better-effect-mq')
    typecheckFixture(fixture)
    smokeWith('bun', fixture)
    smokeWith('node', fixture)

    console.log('better-effect-mq external consumer checks passed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

await main()
