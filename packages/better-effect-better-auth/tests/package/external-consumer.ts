import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const workspaceRoot = resolve(packageRoot, '../..')
const coreSource = join(workspaceRoot, 'packages/better-effect')
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

const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  Object.prototype.toString.call(value) === '[object Object]'

const isJsonString = (value: JsonValue | undefined): value is string =>
  Object.prototype.toString.call(value) === '[object String]'

const parseJsonObject = (text: string, label: string): JsonObject => {
  const value: JsonValue = JSON.parse(text)
  assertCondition(isJsonObject(value), `${label} must be an object`)
  return value
}

const readJsonObject = async (path: string, label: string): Promise<JsonObject> =>
  parseJsonObject(await readFile(path, 'utf8'), label)

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

const buildPackage = (source: string, label: string): void => {
  assertSuccess(run(['bun', 'run', 'build'], source), `Building ${label}`)
}

const pack = async (root: string, source: string, label: string): Promise<string> => {
  const destination = join(root, `pack-${label}`)
  await mkdir(destination)

  assertSuccess(
    run(['bun', 'pm', 'pack', '--destination', destination, '--ignore-scripts'], source),
    `Packing ${label}`
  )

  const archives = (await readdir(destination)).filter((name) => name.endsWith('.tgz'))
  assertCondition(archives.length === 1, `Expected one ${label} archive, found ${archives.length}`)
  return join(destination, archives[0]!)
}

const packMinimumCore = async (root: string): Promise<string> => {
  const destination = join(root, 'pack-better-effect-minimum')
  await mkdir(destination)

  assertSuccess(
    run(['npm', 'pack', 'better-effect@0.12.0', '--pack-destination', destination], packageRoot),
    'Packing better-effect@0.12.0 from the registry'
  )

  const archives = (await readdir(destination)).filter((name) => name.endsWith('.tgz'))
  assertCondition(
    archives.length === 1,
    `Expected one minimum core archive, found ${archives.length}`
  )
  return join(destination, archives[0]!)
}

const archiveEntries = (archive: string): string[] => {
  const result = run(['tar', '-tzf', archive], packageRoot)
  assertSuccess(result, 'Listing the package archive')
  return result.output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

const archiveManifest = (archive: string): JsonObject => {
  const result = run(['tar', '-xOf', archive, 'package/package.json'], packageRoot)
  assertSuccess(result, 'Reading the package archive manifest')
  return parseJsonObject(result.output, 'Package archive manifest')
}

const assertIntegrationArchive = (entries: string[]): void => {
  const expected = [
    'package/CHANGELOG.md',
    'package/LICENSE',
    'package/README.md',
    'package/dist/index.d.mts',
    'package/dist/index.d.mts.map',
    'package/dist/index.mjs',
    'package/dist/index.mjs.map',
    'package/package.json'
  ]

  assertCondition(
    JSON.stringify([...entries].sort()) === JSON.stringify(expected),
    `The integration archive contents changed: ${entries.join(', ')}`
  )
}

const makeFixture = async (
  root: string,
  name: string,
  integrationArchive: string,
  coreArchive: string,
  coreVersion: string
): Promise<string> => {
  const fixture = join(root, name)
  await cp(fixtureSource, fixture, { recursive: true })
  await mkdir(join(fixture, 'examples'), { recursive: true })
  await cp(vanillaExampleSource, join(fixture, 'examples/vanilla-server'), {
    recursive: true
  })

  const artifacts = join(fixture, 'artifacts')
  await mkdir(artifacts)
  await cp(coreArchive, join(artifacts, 'better-effect.tgz'))
  await cp(integrationArchive, join(artifacts, 'better-effect-better-auth.tgz'))

  const manifest = {
    private: true,
    type: 'module',
    dependencies: {
      'better-auth': '1.7.0',
      'better-effect': 'file:./artifacts/better-effect.tgz',
      'better-effect-better-auth': 'file:./artifacts/better-effect-better-auth.tgz',
      'better-result': '3.0.0'
    },
    devDependencies: {
      typescript: '6.0.3'
    },
    peerDependencies: {
      'better-auth': '1.7.0',
      'better-effect': coreVersion,
      'better-result': '3.0.0',
      typescript: '6.0.3'
    }
  }
  await writeFile(join(fixture, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  return fixture
}

const assertFixtureManifest = async (fixture: string, coreVersion: string): Promise<void> => {
  const manifest = await readJsonObject(join(fixture, 'package.json'), 'Consumer package.json')
  const dependencies = manifest['dependencies']
  const devDependencies = manifest['devDependencies']
  const peers = manifest['peerDependencies']

  assertCondition(isJsonObject(dependencies), 'Consumer dependencies must be an object')
  assertCondition(isJsonObject(devDependencies), 'Consumer devDependencies must be an object')
  assertCondition(isJsonObject(peers), 'Consumer peerDependencies must be an object')
  assertCondition(
    dependencies['better-effect'] === 'file:./artifacts/better-effect.tgz',
    'Consumer must install better-effect from the packed file reference'
  )
  assertCondition(
    dependencies['better-effect-better-auth'] === 'file:./artifacts/better-effect-better-auth.tgz',
    'Consumer must install better-effect-better-auth from the packed file reference'
  )

  const expectedPeers = {
    'better-auth': '1.7.0',
    'better-effect': coreVersion,
    'better-result': '3.0.0',
    typescript: '6.0.3'
  }
  for (const [name, version] of Object.entries(expectedPeers)) {
    assertCondition(peers[name] === version, `Consumer peer ${name} must be pinned to ${version}`)
  }
  assertCondition(devDependencies['typescript'] === '6.0.3', 'Consumer TypeScript must be exact')
}

const assertInstalledPackage = async (
  fixture: string,
  name: string,
  version: string
): Promise<void> => {
  const installed = join(fixture, 'node_modules', name)
  const manifest = await readJsonObject(join(installed, 'package.json'), `${name} manifest`)
  assertCondition(manifest['name'] === name, `Installed package has the wrong name for ${name}`)
  assertCondition(manifest['version'] === version, `${name} must be installed at ${version}`)

  const resolved = await realpath(installed)
  assertCondition(
    !resolved.startsWith(`${workspaceRoot}${sep}`),
    `${name} resolved through the monorepo instead of the isolated consumer`
  )
}

const installConsumer = async (
  fixture: string,
  coreVersion: string,
  integrationVersion: string
): Promise<void> => {
  await assertFixtureManifest(fixture, coreVersion)
  assertSuccess(run(['bun', 'install', '--ignore-scripts'], fixture), 'Installing packed consumer')
  assertSuccess(
    run(['bun', 'install', '--frozen-lockfile', '--ignore-scripts'], fixture),
    'Reinstalling packed consumer from its lockfile'
  )

  const lockfile = await readFile(join(fixture, 'bun.lock'), 'utf8')
  for (const name of [
    'better-auth',
    'better-effect',
    'better-effect-better-auth',
    'better-result'
  ]) {
    assertCondition(lockfile.includes(name), `Consumer lockfile is missing ${name}`)
  }
  assertCondition(
    !lockfile.includes('workspace:'),
    'Consumer lockfile contains a workspace reference'
  )

  const graph = run(['bun', 'pm', 'ls'], fixture)
  assertSuccess(graph, 'Inspecting the packed consumer dependency graph')
  for (const name of [
    'better-auth',
    'better-effect',
    'better-effect-better-auth',
    'better-result'
  ]) {
    assertCondition(graph.output.includes(name), `Consumer graph is missing ${name}`)
  }

  await assertInstalledPackage(fixture, 'better-auth', '1.7.0')
  await assertInstalledPackage(fixture, 'better-effect', coreVersion)
  await assertInstalledPackage(fixture, 'better-effect-better-auth', integrationVersion)
  await assertInstalledPackage(fixture, 'better-result', '3.0.0')
  await assertInstalledPackage(fixture, 'typescript', '6.0.3')
}

const hasDeclarationFile = async (directory: string): Promise<boolean> => {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory() && (await hasDeclarationFile(path))) return true
    if (entry.isFile() && entry.name.endsWith('.d.ts')) return true
  }
  return false
}

const declarationCheck = async (fixture: string): Promise<void> => {
  const tsconfig = join(fixture, 'declaration-tsconfig.json')
  assertSuccess(
    run(['bun', 'x', 'tsc', '-p', tsconfig, '--pretty', 'false'], fixture),
    'External declaration emit with the installed TypeScript'
  )
  assertSuccess(
    run(
      [
        'bunx',
        '--bun',
        '--package',
        'typescript@5.7.2',
        'tsc',
        '-p',
        tsconfig,
        '--pretty',
        'false'
      ],
      fixture
    ),
    'External declaration emit with TypeScript 5.7.2'
  )
  assertCondition(
    await hasDeclarationFile(join(fixture, 'declarations')),
    'External declaration emit did not produce a .d.ts file'
  )
}

const assertPackedSourceMaps = async (installedPackage: string): Promise<void> => {
  for (const mapName of ['dist/index.mjs.map', 'dist/index.d.mts.map']) {
    const value = await readJsonObject(join(installedPackage, mapName), mapName)
    const rawSources = value['sources']
    assertCondition(Array.isArray(rawSources), `Source map ${mapName} must list sources`)
    const sources: string[] = []
    for (const source of rawSources) {
      assertCondition(isJsonString(source), `Source map ${mapName} contains a non-string source`)
      sources.push(source)
    }
    for (const source of sources) {
      assertCondition(
        !isAbsolute(source) && !source.includes('node_modules') && !source.includes('/tmp/'),
        `Source map ${mapName} leaks a private build path: ${source}`
      )
    }
  }
}

const typecheckFixture = (fixture: string): void => {
  const tsconfig = join(fixture, 'tsconfig.json')
  assertSuccess(
    run(['bun', 'x', 'tsc', '-p', tsconfig, '--pretty', 'false'], fixture),
    'External fixture typecheck with the installed TypeScript'
  )
  assertSuccess(
    run(
      [
        'bunx',
        '--bun',
        '--package',
        'typescript@5.7.2',
        'tsc',
        '-p',
        tsconfig,
        '--pretty',
        'false'
      ],
      fixture
    ),
    'External fixture typecheck with TypeScript 5.7.2'
  )
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
  coreVersion: string,
  integrationVersion: string,
  label: string
): Promise<void> => {
  await installConsumer(fixture, coreVersion, integrationVersion)
  const installedIntegration = join(fixture, 'node_modules', 'better-effect-better-auth')
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
    buildPackage(coreSource, 'better-effect')
    buildPackage(packageRoot, 'better-effect-better-auth')
    const integrationArchive = await pack(root, packageRoot, 'better-effect-better-auth')
    const coreArchive = await pack(root, coreSource, 'better-effect')
    const minimumCoreArchive = await packMinimumCore(root)
    assertIntegrationArchive(archiveEntries(integrationArchive))

    const integrationManifest = archiveManifest(integrationArchive)
    const coreManifest = archiveManifest(coreArchive)
    const minimumCoreManifest = archiveManifest(minimumCoreArchive)
    const integrationVersion = integrationManifest['version']
    const coreVersion = coreManifest['version']
    const minimumCoreVersion = minimumCoreManifest['version']
    assertCondition(isJsonString(integrationVersion), 'Integration archive version is missing')
    assertCondition(isJsonString(coreVersion), 'Core archive version is missing')
    assertCondition(isJsonString(minimumCoreVersion), 'Minimum core archive version is missing')

    const fixture = await makeFixture(
      root,
      'consumer',
      integrationArchive,
      coreArchive,
      coreVersion
    )
    await exerciseFixture(fixture, coreVersion, integrationVersion, 'current')

    const minimumFixture = await makeFixture(
      root,
      'minimum-consumer',
      integrationArchive,
      minimumCoreArchive,
      minimumCoreVersion
    )
    await exerciseFixture(minimumFixture, minimumCoreVersion, integrationVersion, 'minimum-peer')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

await main()
