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
const minimumBetterEffectVersion = '0.12.0'

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
    run(
      [
        'npm',
        'pack',
        `better-effect@${minimumBetterEffectVersion}`,
        '--pack-destination',
        destination
      ],
      packageRoot
    ),
    `Packing better-effect@${minimumBetterEffectVersion} from the registry`
  )

  const archives = (await readdir(destination)).filter((name) => name.endsWith('.tgz'))
  assertCondition(
    archives.length === 1,
    `Expected one minimum core archive, found ${archives.length}`
  )
  return join(destination, archives[0]!)
}

const packHono = async (root: string, version: string, label: string): Promise<string> => {
  const destination = join(root, `pack-hono-${label}`)
  await mkdir(destination)

  assertSuccess(
    run(['npm', 'pack', `hono@${version}`, '--pack-destination', destination], packageRoot),
    `Packing hono@${version} from the registry`
  )

  const archives = (await readdir(destination)).filter((name) => name.endsWith('.tgz'))
  assertCondition(
    archives.length === 1,
    `Expected one ${label} Hono archive, found ${archives.length}`
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
  const fixedEntries = [
    'package/CHANGELOG.md',
    'package/LICENSE',
    'package/README.md',
    'package/dist/hono.d.mts',
    'package/dist/hono.d.mts.map',
    'package/dist/hono.mjs',
    'package/dist/hono.mjs.map',
    'package/dist/hooks.d.mts',
    'package/dist/hooks.d.mts.map',
    'package/dist/hooks.mjs',
    'package/dist/hooks.mjs.map',
    'package/dist/index.d.mts',
    'package/dist/index.mjs',
    'package/dist/index.mjs.map',
    'package/package.json'
  ]
  const fixed = new Set(fixedEntries)
  const hashed = entries.filter((entry) => !fixed.has(entry))

  assertCondition(
    hashed.length === 4 &&
      hashed.some((entry) => /^package\/dist\/errors-[^/]+\.mjs$/.test(entry)) &&
      hashed.some((entry) => /^package\/dist\/errors-[^/]+\.mjs\.map$/.test(entry)) &&
      hashed.some((entry) => /^package\/dist\/service-[^/]+\.d\.mts$/.test(entry)) &&
      hashed.some((entry) => /^package\/dist\/service-[^/]+\.d\.mts\.map$/.test(entry)),
    `The integration archive chunks changed: ${hashed.join(', ')}`
  )

  const expected = [...fixedEntries, ...hashed].sort()
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
  coreVersion: string,
  honoArchive: string,
  honoVersion: string,
  includeHono: boolean
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
  if (includeHono) await cp(honoArchive, join(artifacts, 'hono.tgz'))
  await cp(integrationArchive, join(artifacts, 'better-effect-better-auth.tgz'))

  const dependencies = {
    'better-auth': '1.7.0',
    'better-effect': 'file:./artifacts/better-effect.tgz',
    'better-effect-better-auth': 'file:./artifacts/better-effect-better-auth.tgz',
    'better-result': '3.0.0'
  }
  const peerDependencies = {
    'better-auth': '1.7.0',
    'better-effect': coreVersion,
    'better-result': '3.0.0',
    typescript: '6.0.3'
  }
  if (includeHono) {
    Object.assign(dependencies, { hono: 'file:./artifacts/hono.tgz' })
    Object.assign(peerDependencies, { hono: honoVersion })
  }
  const manifest = {
    private: true,
    type: 'module',
    dependencies,
    devDependencies: {
      typescript: '6.0.3'
    },
    peerDependencies
  }
  await writeFile(join(fixture, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  return fixture
}

const assertFixtureManifest = async (
  fixture: string,
  coreVersion: string,
  honoVersion: string,
  includeHono: boolean
): Promise<void> => {
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
  if (includeHono) {
    assertCondition(
      dependencies['hono'] === 'file:./artifacts/hono.tgz',
      'Hono consumer must install Hono from the packed file reference'
    )
  } else {
    assertCondition(dependencies['hono'] === undefined, 'Core consumer must not install Hono')
  }

  const expectedPeers = {
    'better-auth': '1.7.0',
    'better-effect': coreVersion,
    'better-result': '3.0.0',
    typescript: '6.0.3'
  }
  if (includeHono) Object.assign(expectedPeers, { hono: honoVersion })
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
  integrationVersion: string,
  honoVersion: string,
  includeHono: boolean
): Promise<void> => {
  await assertFixtureManifest(fixture, coreVersion, honoVersion, includeHono)
  assertSuccess(run(['bun', 'install', '--ignore-scripts'], fixture), 'Installing packed consumer')
  assertSuccess(
    run(['bun', 'install', '--frozen-lockfile', '--ignore-scripts'], fixture),
    'Reinstalling packed consumer from its lockfile'
  )

  const lockfile = await readFile(join(fixture, 'bun.lock'), 'utf8')
  const lockedNames = ['better-auth', 'better-effect', 'better-effect-better-auth', 'better-result']
  if (includeHono) lockedNames.push('hono')
  for (const name of lockedNames) {
    assertCondition(lockfile.includes(name), `Consumer lockfile is missing ${name}`)
  }
  if (!includeHono) {
    const installedEntries = await readdir(join(fixture, 'node_modules'))
    assertCondition(!installedEntries.includes('hono'), 'Core consumer must not install Hono')
  }
  assertCondition(
    !lockfile.includes('workspace:'),
    'Consumer lockfile contains a workspace reference'
  )

  const graph = run(['bun', 'pm', 'ls'], fixture)
  assertSuccess(graph, 'Inspecting the packed consumer dependency graph')
  for (const name of lockedNames) {
    assertCondition(graph.output.includes(name), `Consumer graph is missing ${name}`)
  }

  await assertInstalledPackage(fixture, 'better-auth', '1.7.0')
  await assertInstalledPackage(fixture, 'better-effect', coreVersion)
  await assertInstalledPackage(fixture, 'better-effect-better-auth', integrationVersion)
  await assertInstalledPackage(fixture, 'better-result', '3.0.0')
  if (includeHono) await assertInstalledPackage(fixture, 'hono', honoVersion)
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

const declarationCheck = async (fixture: string, includeHono: boolean): Promise<void> => {
  const configName = includeHono ? 'hono-declaration-tsconfig.json' : 'declaration-tsconfig.json'
  const tsconfig = join(fixture, configName)
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
  if (includeHono) {
    const honoDeclaration = await readFile(join(fixture, 'declarations/hono.d.ts'), 'utf8')
    assertCondition(
      honoDeclaration.includes('BetterAuthHonoSessionToken') &&
        honoDeclaration.includes('BetterAuthHonoSessionValue'),
      'Hono declarations must retain the named public session aliases'
    )
  }
}

const assertPackedSourceMaps = async (installedPackage: string): Promise<void> => {
  for (const mapName of [
    'dist/hono.mjs.map',
    'dist/hono.d.mts.map',
    'dist/hooks.mjs.map',
    'dist/hooks.d.mts.map',
    'dist/index.mjs.map'
  ]) {
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

const typecheckFixture = (fixture: string, includeHono: boolean): void => {
  const configName = includeHono ? 'hono-tsconfig.json' : 'tsconfig.json'
  const tsconfig = join(fixture, configName)
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

const smokeWith = (runtime: 'bun' | 'node', fixture: string, script = 'smoke.mjs'): void => {
  assertSuccess(run([runtime, script], fixture), `External ${script} smoke test with ${runtime}`)
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
  honoVersion: string,
  label: string,
  includeHono: boolean
): Promise<void> => {
  await installConsumer(fixture, coreVersion, integrationVersion, honoVersion, includeHono)
  const installedIntegration = join(fixture, 'node_modules', 'better-effect-better-auth')
  await assertPackedSourceMaps(installedIntegration)
  typecheckFixture(fixture, includeHono)
  await declarationCheck(fixture, includeHono)
  smokeWith('bun', fixture)
  smokeWith('node', fixture)
  if (includeHono) {
    smokeWith('bun', fixture, 'hono-smoke.mjs')
    smokeWith('node', fixture, 'hono-smoke.mjs')
  }
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
    const currentHonoArchive = await packHono(root, '4.13.3', 'current')
    const minimumHonoArchive = await packHono(root, '4.0.0', 'minimum')
    assertIntegrationArchive(archiveEntries(integrationArchive))

    const integrationManifest = archiveManifest(integrationArchive)
    const coreManifest = archiveManifest(coreArchive)
    const minimumCoreManifest = archiveManifest(minimumCoreArchive)
    const currentHonoManifest = archiveManifest(currentHonoArchive)
    const minimumHonoManifest = archiveManifest(minimumHonoArchive)
    const integrationVersion = integrationManifest['version']
    const coreVersion = coreManifest['version']
    const minimumCoreVersion = minimumCoreManifest['version']
    const currentHonoVersion = currentHonoManifest['version']
    const minimumHonoVersion = minimumHonoManifest['version']
    assertCondition(isJsonString(integrationVersion), 'Integration archive version is missing')
    assertCondition(isJsonString(coreVersion), 'Core archive version is missing')
    assertCondition(isJsonString(minimumCoreVersion), 'Minimum core archive version is missing')
    assertCondition(
      minimumCoreVersion === minimumBetterEffectVersion,
      `Minimum core archive must be better-effect@${minimumBetterEffectVersion}, got ${minimumCoreVersion}`
    )
    assertCondition(isJsonString(currentHonoVersion), 'Current Hono archive version is missing')
    assertCondition(isJsonString(minimumHonoVersion), 'Minimum Hono archive version is missing')

    const currentCoreFixture = await makeFixture(
      root,
      'current-core-consumer',
      integrationArchive,
      coreArchive,
      coreVersion,
      currentHonoArchive,
      currentHonoVersion,
      false
    )
    await exerciseFixture(
      currentCoreFixture,
      coreVersion,
      integrationVersion,
      currentHonoVersion,
      'current-core',
      false
    )

    const currentHonoFixture = await makeFixture(
      root,
      'current-hono-consumer',
      integrationArchive,
      coreArchive,
      coreVersion,
      currentHonoArchive,
      currentHonoVersion,
      true
    )
    await exerciseFixture(
      currentHonoFixture,
      coreVersion,
      integrationVersion,
      currentHonoVersion,
      'current-hono',
      true
    )

    const minimumCoreFixture = await makeFixture(
      root,
      'minimum-core-consumer',
      integrationArchive,
      minimumCoreArchive,
      minimumCoreVersion,
      minimumHonoArchive,
      minimumHonoVersion,
      false
    )
    await exerciseFixture(
      minimumCoreFixture,
      minimumCoreVersion,
      integrationVersion,
      minimumHonoVersion,
      'minimum-core',
      false
    )

    const minimumHonoFixture = await makeFixture(
      root,
      'minimum-hono-consumer',
      integrationArchive,
      minimumCoreArchive,
      minimumCoreVersion,
      minimumHonoArchive,
      minimumHonoVersion,
      true
    )
    await exerciseFixture(
      minimumHonoFixture,
      minimumCoreVersion,
      integrationVersion,
      minimumHonoVersion,
      'minimum-hono',
      true
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

await main()
