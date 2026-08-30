import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('../..', import.meta.url))
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

const pack = async (root: string): Promise<string> => {
  const destination = join(root, 'pack')
  await mkdir(destination)

  const result = run(
    ['bun', 'pm', 'pack', '--destination', destination, '--ignore-scripts'],
    packageRoot
  )
  assertSuccess(result, 'Packing better-effect-mq')

  const archives = (await readdir(destination)).filter((name) => name.endsWith('.tgz'))
  assertCondition(archives.length === 1, `Expected one package archive, found ${archives.length}`)

  const archive = archives[0]
  assertCondition(archive !== undefined, 'Package archive name was not returned')

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

const assertArchiveContents = (entries: string[]): void => {
  const entrySet = new Set(entries)
  const required = [
    'package/package.json',
    'package/LICENSE',
    'package/README.md',
    'package/dist/index.mjs',
    'package/dist/index.d.mts',
    'package/dist/testing.mjs',
    'package/dist/testing.d.mts'
  ]

  for (const entry of required) {
    assertCondition(entrySet.has(entry), `The package archive is missing ${entry}`)
  }

  assertCondition(
    !entries.some(
      (entry) => entry.startsWith('package/src/') || entry.startsWith('package/tests/')
    ),
    'The package archive contains development source or tests'
  )
}

const installPeerDependencies = (fixture: string): void => {
  const result = run(['bun', 'install', '--ignore-scripts', '--no-save'], fixture)
  assertSuccess(result, 'Installing the better-effect and better-result peer dependencies')
}

const installArchive = async (archive: string, fixture: string): Promise<string> => {
  const nodeModules = join(fixture, 'node_modules')
  const installedPackage = join(nodeModules, 'better-effect-mq')

  await mkdir(nodeModules, { recursive: true })
  const result = run(['tar', '-xzf', archive, '-C', nodeModules], fixture)
  assertSuccess(result, 'Extracting the package archive')
  await rename(join(nodeModules, 'package'), installedPackage)

  return installedPackage
}

const assertPackedManifest = async (installedPackage: string): Promise<void> => {
  const value: JsonValue = JSON.parse(
    await readFile(join(installedPackage, 'package.json'), 'utf8')
  )

  assertCondition(isJsonObject(value), 'Packed package metadata must be an object')

  assertCondition(value['name'] === 'better-effect-mq', 'Packed package has the wrong name')
  assertCondition(value['type'] === 'module', 'Packed package is not ESM')
}

const typecheckFixture = (fixture: string): void => {
  const tsconfig = join(fixture, 'tsconfig.json')
  const current = run(
    ['bun', 'run', '--silent', 'tsc', '--', '-p', tsconfig, '--pretty', 'false'],
    packageRoot
  )
  assertSuccess(current, 'External fixture typecheck with the project TypeScript')

  const minimum = run(
    ['bunx', '--bun', '--package', 'typescript@5.7.2', 'tsc', '-p', tsconfig, '--pretty', 'false'],
    fixture
  )
  assertSuccess(minimum, 'External fixture typecheck with TypeScript 5.7.2')
}

const smokeWith = (runtime: 'bun' | 'node', fixture: string): void => {
  const result = run([runtime, 'smoke.mjs'], fixture)
  assertSuccess(result, `External consumer smoke test with ${runtime}`)
}

const assertNode24 = (): void => {
  const result = run(['node', '--version'], packageRoot)
  assertSuccess(result, 'Checking the Node.js runtime')
  assertCondition(
    result.output.trim().startsWith('v24.'),
    'The external Node smoke test requires Node.js 24'
  )
}

const main = async (): Promise<void> => {
  assertNode24()
  const root = await makeFixture()

  try {
    const archive = await pack(root)
    assertArchiveContents(archiveEntries(archive))
    const fixture = join(root, 'consumer')
    installPeerDependencies(fixture)
    const installedPackage = await installArchive(archive, fixture)

    await assertPackedManifest(installedPackage)
    typecheckFixture(fixture)
    smokeWith('bun', fixture)
    smokeWith('node', fixture)

    console.log('better-effect-mq external consumer checks passed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

await main()
