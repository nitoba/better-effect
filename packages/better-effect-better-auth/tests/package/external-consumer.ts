import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const workspaceRoot = resolve(packageRoot, '../..')
const coreSource = join(workspaceRoot, 'packages/better-effect')
const workspaceNodeModules = join(workspaceRoot, 'node_modules')
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

type CommandResult = {
  readonly exitCode: number
  readonly output: string
}

const isJsonObject = (value: JsonValue): value is JsonObject =>
  Object.prototype.toString.call(value) === '[object Object]'

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

const shouldCopyCorePath = (source: string): boolean => {
  const fromCore = relative(coreSource, source)

  if (fromCore === '') {
    return true
  }

  const rootSegment = fromCore.split(sep)[0]

  return (
    rootSegment !== 'node_modules' &&
    rootSegment !== 'dist' &&
    rootSegment !== 'coverage' &&
    rootSegment !== '.turbo'
  )
}

const prepareCorePackage = async (root: string): Promise<string> => {
  const copy = join(root, 'better-effect-source')

  await cp(coreSource, copy, {
    recursive: true,
    filter: shouldCopyCorePath
  })
  await symlink(workspaceNodeModules, join(copy, 'node_modules'), 'dir')
  assertSuccess(run(['bun', 'run', 'build'], copy), 'Building copied better-effect package')

  return copy
}

const pack = async (root: string, source: string, label: string): Promise<string> => {
  const destination = join(root, `pack-${label}`)
  await mkdir(destination)

  const result = run(['bun', 'pm', 'pack', '--destination', destination, '--ignore-scripts'], source)
  assertSuccess(result, `Packing ${label}`)

  const archives = (await readdir(destination)).filter((name) => name.endsWith('.tgz'))
  assertCondition(archives.length === 1, `Expected one ${label} archive, found ${archives.length}`)

  const archive = archives[0]
  assertCondition(archive !== undefined, `${label} archive name was not returned`)

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

const assertIntegrationArchive = (entries: string[]): void => {
  const entrySet = new Set(entries)
  const required = [
    'package/package.json',
    'package/LICENSE',
    'package/README.md',
    'package/dist/index.mjs',
    'package/dist/index.d.mts'
  ]

  for (const entry of required) {
    assertCondition(entrySet.has(entry), `The integration archive is missing ${entry}`)
  }

  assertCondition(
    !entries.some(
      (entry) => entry.startsWith('package/src/') || entry.startsWith('package/tests/')
    ),
    'The integration archive contains development source or tests'
  )
}

const makeFixture = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'better-effect-better-auth-consumer-'))
  await cp(fixtureSource, join(root, 'consumer'), { recursive: true })

  return root
}

const installPeerDependencies = (fixture: string): void => {
  assertSuccess(
    run(['bun', 'install', '--ignore-scripts', '--no-save'], fixture),
    'Installing external consumer peer dependencies'
  )
}

const installArchive = async (
  archive: string,
  fixture: string,
  packageName: string
): Promise<string> => {
  const nodeModules = join(fixture, 'node_modules')
  const installedPackage = join(nodeModules, packageName)

  await mkdir(nodeModules, { recursive: true })
  const result = run(['tar', '-xzf', archive, '-C', nodeModules], fixture)
  assertSuccess(result, `Extracting ${packageName}`)
  await rename(join(nodeModules, 'package'), installedPackage)

  return installedPackage
}

const assertPackedManifest = async (installedPackage: string): Promise<void> => {
  const value: JsonValue = JSON.parse(
    await readFile(join(installedPackage, 'package.json'), 'utf8')
  )

  assertCondition(isJsonObject(value), 'Packed package metadata must be an object')
  assertCondition(
    value['name'] === 'better-effect-better-auth',
    'Packed package has the wrong name'
  )
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
  assertSuccess(run([runtime, 'smoke.mjs'], fixture), `External smoke test with ${runtime}`)
}

const assertNode24 = (): void => {
  const result = run(['node', '--version'], packageRoot)
  assertSuccess(result, 'Checking the Node.js runtime')
  assertCondition(result.output.trim().startsWith('v24.'), 'The smoke test requires Node.js 24')
}

const main = async (): Promise<void> => {
  assertNode24()
  const root = await makeFixture()

  try {
    const coreCopy = await prepareCorePackage(root)
    const integrationArchive = await pack(root, packageRoot, 'better-effect-better-auth')
    const coreArchive = await pack(root, coreCopy, 'better-effect')
    assertIntegrationArchive(archiveEntries(integrationArchive))

    const fixture = join(root, 'consumer')
    installPeerDependencies(fixture)
    await installArchive(coreArchive, fixture, 'better-effect')
    const installedIntegration = await installArchive(
      integrationArchive,
      fixture,
      'better-effect-better-auth'
    )

    await assertPackedManifest(installedIntegration)
    typecheckFixture(fixture)
    smokeWith('bun', fixture)
    smokeWith('node', fixture)

    console.log('better-effect-better-auth external consumer checks passed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

await main()
