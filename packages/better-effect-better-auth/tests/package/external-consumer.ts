import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const workspaceRoot = resolve(packageRoot, '../..')
const coreSource = join(workspaceRoot, 'packages/better-effect')
const coreNodeModules = join(coreSource, 'node_modules')
const fixtureSource = join(packageRoot, 'tests/package/consumer')
const vanillaExampleSource = join(packageRoot, 'examples/vanilla-server')
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

const isJsonString = (value: JsonValue | undefined): value is string =>
  Object.prototype.toString.call(value) === '[object String]'

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

const shouldCopyPath = (sourceRoot: string, source: string): boolean => {
  const fromRoot = relative(sourceRoot, source)

  if (fromRoot === '') {
    return true
  }

  const rootSegment = fromRoot.split(sep)[0]

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
    filter: (source) => shouldCopyPath(coreSource, source)
  })
  await symlink(coreNodeModules, join(copy, 'node_modules'), 'dir')
  assertSuccess(run(['bun', 'run', 'build'], copy), 'Building copied better-effect package')

  return copy
}

const linkIntegrationDependencies = async (copy: string, coreCopy: string): Promise<void> => {
  const destination = join(copy, 'node_modules')
  await mkdir(destination)

  for (const entry of await readdir(join(packageRoot, 'node_modules'), {
    withFileTypes: true
  })) {
    if (entry.name === 'better-effect') {
      continue
    }

    await symlink(
      join(packageRoot, 'node_modules', entry.name),
      join(destination, entry.name),
      entry.isDirectory() ? 'dir' : 'file'
    )
  }

  await symlink(coreCopy, join(destination, 'better-effect'), 'dir')
}

const prepareIntegrationPackage = async (root: string, coreCopy: string): Promise<string> => {
  const copy = join(root, 'better-effect-better-auth-source')

  await cp(packageRoot, copy, {
    recursive: true,
    filter: (source) => shouldCopyPath(packageRoot, source)
  })
  await linkIntegrationDependencies(copy, coreCopy)

  const coreManifest: JsonValue = JSON.parse(await readFile(join(coreCopy, 'package.json'), 'utf8'))
  assertCondition(isJsonObject(coreManifest), 'Copied core package metadata must be an object')
  const coreVersion = coreManifest['version']
  assertCondition(isJsonString(coreVersion), 'Copied core package version must be a string')

  const manifestPath = join(copy, 'package.json')
  const manifest = await readFile(manifestPath, 'utf8')
  const workspaceDependency = '"better-effect": "workspace:*"'
  assertCondition(
    manifest.includes(workspaceDependency),
    'Copied integration package must start with its workspace dependency marker'
  )
  await writeFile(
    manifestPath,
    manifest.replace(workspaceDependency, `"better-effect": "${coreVersion}"`)
  )

  assertSuccess(
    run(['bun', 'run', 'build'], copy),
    'Building copied better-effect-better-auth package'
  )

  return copy
}

const pack = async (root: string, source: string, label: string): Promise<string> => {
  const destination = join(root, `pack-${label}`)
  await mkdir(destination)

  const result = run(
    ['bun', 'pm', 'pack', '--destination', destination, '--ignore-scripts'],
    source
  )
  assertSuccess(result, `Packing ${label}`)

  const archives = (await readdir(destination)).filter((name) => name.endsWith('.tgz'))
  assertCondition(archives.length === 1, `Expected one ${label} archive, found ${archives.length}`)

  const archive = archives[0]
  assertCondition(archive !== undefined, `${label} archive name was not returned`)

  return join(destination, archive)
}

const packMinimumCore = async (root: string): Promise<string> => {
  const destination = join(root, 'pack-better-effect-minimum')
  await mkdir(destination)

  const result = run(
    ['npm', 'pack', 'better-effect@0.12.0', '--pack-destination', destination],
    packageRoot
  )
  assertSuccess(result, 'Packing better-effect@0.12.0 from the registry')

  const archives = (await readdir(destination)).filter((name) => name.endsWith('.tgz'))
  assertCondition(
    archives.length === 1,
    `Expected one minimum core archive, found ${archives.length}`
  )

  const archive = archives[0]
  assertCondition(archive !== undefined, 'Minimum core archive name was not returned')

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
  const expected = [
    'package/LICENSE',
    'package/README.md',
    'package/dist/index.d.mts',
    'package/dist/index.d.mts.map',
    'package/dist/index.mjs',
    'package/dist/index.mjs.map',
    'package/package.json'
  ]
  const actual = [...entries].sort()

  assertCondition(
    JSON.stringify(actual) === JSON.stringify(expected),
    `The integration archive contents changed: ${actual.join(', ')}`
  )
}

const makeFixture = async (root: string, name: string): Promise<string> => {
  const fixture = join(root, name)
  await cp(fixtureSource, fixture, { recursive: true })
  await mkdir(join(fixture, 'examples'), { recursive: true })
  await cp(vanillaExampleSource, join(fixture, 'examples/vanilla-server'), {
    recursive: true
  })

  return fixture
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

  const peers = value['peerDependencies']
  assertCondition(
    peers !== undefined && isJsonObject(peers),
    'Packed package must declare peer dependencies'
  )
  assertCondition(
    peers['better-auth'] === '^1.7.0',
    'Packed package has the wrong Better Auth peer range'
  )
  assertCondition(
    peers['better-effect'] === '>=0.12.0 <0.14.0',
    'Packed package has the wrong better-effect peer range'
  )
  assertCondition(
    peers['better-result'] === '^3.0.0',
    'Packed package has the wrong better-result peer range'
  )
}

const hasDeclarationFile = async (directory: string): Promise<boolean> => {
  const entries = await readdir(directory, { withFileTypes: true })

  for (const entry of entries) {
    const path = join(directory, entry.name)

    if (entry.isDirectory() && (await hasDeclarationFile(path))) {
      return true
    }
    if (entry.isFile() && entry.name.endsWith('.d.ts')) {
      return true
    }
  }

  return false
}

const declarationCheck = async (fixture: string): Promise<void> => {
  const tsconfig = join(fixture, 'declaration-tsconfig.json')
  const current = run(
    ['bun', 'run', '--silent', 'tsc', '--', '-p', tsconfig, '--pretty', 'false'],
    packageRoot
  )
  assertSuccess(current, 'External declaration emit with the project TypeScript')

  const minimum = run(
    ['bunx', '--bun', '--package', 'typescript@5.7.2', 'tsc', '-p', tsconfig, '--pretty', 'false'],
    fixture
  )
  assertSuccess(minimum, 'External declaration emit with TypeScript 5.7.2')
  assertCondition(
    await hasDeclarationFile(join(fixture, 'declarations')),
    'External declaration emit did not produce a .d.ts file'
  )
}

const assertPackedSourceMaps = async (installedPackage: string): Promise<void> => {
  for (const mapName of ['dist/index.mjs.map', 'dist/index.d.mts.map']) {
    const value: JsonValue = JSON.parse(await readFile(join(installedPackage, mapName), 'utf8'))

    assertCondition(isJsonObject(value), `Source map ${mapName} must be an object`)
    const sources = value['sources']
    assertCondition(Array.isArray(sources), `Source map ${mapName} must list sources`)

    for (const source of sources) {
      assertCondition(isJsonString(source), `Source map ${mapName} contains a non-string source`)
      assertCondition(
        !isAbsolute(source) && !source.includes('node_modules') && !source.includes('/tmp/'),
        `Source map ${mapName} leaks a private build path: ${source}`
      )
    }
  }
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

const runVanillaExample = (fixture: string, label: string): void => {
  const result = run(['bun', 'examples/vanilla-server/handler.ts'], fixture)
  assertSuccess(result, `Running the vanilla example in the ${label} fixture`)
  assertCondition(
    result.output.includes('{"users":1,"sessionUser":"admin@example.com"}'),
    `The vanilla example produced an unexpected result in the ${label} fixture:\n${result.output}`
  )
}

const exerciseFixture = async (
  fixture: string,
  integrationArchive: string,
  coreArchive: string,
  label: string
): Promise<void> => {
  installPeerDependencies(fixture)
  await installArchive(coreArchive, fixture, 'better-effect')
  const installedIntegration = await installArchive(
    integrationArchive,
    fixture,
    'better-effect-better-auth'
  )

  await assertPackedManifest(installedIntegration)
  await assertPackedSourceMaps(installedIntegration)
  typecheckFixture(fixture)
  await declarationCheck(fixture)
  smokeWith('bun', fixture)
  smokeWith('node', fixture)
  runVanillaExample(fixture, label)
  console.log(`${label} external consumer checks passed`)
}

const assertNode24 = (): void => {
  const result = run(['node', '--version'], packageRoot)
  assertSuccess(result, 'Checking the Node.js runtime')
  assertCondition(result.output.trim().startsWith('v24.'), 'The smoke test requires Node.js 24')
}

const main = async (): Promise<void> => {
  assertNode24()
  const root = await mkdtemp(join(tmpdir(), 'better-effect-better-auth-consumer-'))

  try {
    const coreCopy = await prepareCorePackage(root)
    const integrationCopy = await prepareIntegrationPackage(root, coreCopy)
    const integrationArchive = await pack(root, integrationCopy, 'better-effect-better-auth')
    const coreArchive = await pack(root, coreCopy, 'better-effect')
    const minimumCoreArchive = await packMinimumCore(root)
    assertIntegrationArchive(archiveEntries(integrationArchive))

    const fixture = await makeFixture(root, 'consumer')
    await exerciseFixture(fixture, integrationArchive, coreArchive, 'current')

    const minimumFixture = await makeFixture(root, 'minimum-consumer')
    await exerciseFixture(minimumFixture, integrationArchive, minimumCoreArchive, 'minimum-peer')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

await main()
