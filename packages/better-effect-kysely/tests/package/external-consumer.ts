import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const coreRoot = resolve(packageRoot, '../better-effect')
const fixtureSource = join(packageRoot, 'tests/package/consumer')
const importFixtureSource = join(packageRoot, 'tests/package/import-consumer')
const decoder = new TextDecoder()

type CommandResult = {
  readonly exitCode: number
  readonly output: string
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

type JsonObject = { readonly [key: string]: JsonValue }

type ArchiveSet = {
  readonly core: string
  readonly kysely: string
}

type RuntimeName = 'bun' | 'node'
type DialectName = 'pglite' | 'sqlite'
type VersionCell = {
  readonly label: 'consumer-minimum' | 'consumer-current-tested'
  readonly spec: string
  readonly expectedVersion: string
}

const assertCondition: (condition: boolean, message: string) => asserts condition = (
  condition,
  message
) => {
  if (!condition) throw new Error(message)
}

const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  value !== undefined && Object.prototype.toString.call(value) === '[object Object]'

const isJsonString = (value: JsonValue | undefined): value is string =>
  value !== undefined && Object.prototype.toString.call(value) === '[object String]'

const run = (command: string[], cwd: string): CommandResult => {
  const cache = process.env.BUN_INSTALL_CACHE_DIR
  const result = Bun.spawnSync(command, {
    cwd,
    stderr: 'pipe',
    stdout: 'pipe',
    env: cache === undefined ? process.env : { ...process.env, BUN_INSTALL_CACHE_DIR: cache }
  })
  return {
    exitCode: result.exitCode,
    output: `${decoder.decode(result.stdout)}\n${decoder.decode(result.stderr)}`
  }
}

const assertSuccess = (result: CommandResult, label: string): void => {
  assertCondition(result.exitCode === 0, `${label} failed:\n${result.output}`)
}

const pack = async (
  root: string,
  packageDirectory: string,
  packageName: string
): Promise<string> => {
  const destination = join(root, 'archives', packageName)
  await mkdir(destination, { recursive: true })
  assertSuccess(
    run(['bun', 'pm', 'pack', '--destination', destination, '--ignore-scripts'], packageDirectory),
    `Packing ${packageName}`
  )
  const archives = (await readdir(destination)).filter((entry) => entry.endsWith('.tgz'))
  assertCondition(
    archives.length === 1,
    `Expected one ${packageName} archive, found ${archives.length}`
  )
  return join(destination, archives[0]!)
}

const packArtifacts = async (root: string): Promise<ArchiveSet> => ({
  core: await pack(root, coreRoot, 'better-effect'),
  kysely: await pack(root, packageRoot, 'better-effect-kysely')
})

const archiveEntries = (archive: string): string[] => {
  const result = run(['tar', '-tzf', archive], packageRoot)
  assertSuccess(result, 'Listing a package archive')
  return result.output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

const assertArchive = (archive: string, packageName: string, requiresChangelog: boolean): void => {
  const entries = new Set(archiveEntries(archive))
  for (const required of [
    'package/package.json',
    'package/LICENSE',
    'package/README.md',
    'package/dist/index.mjs',
    'package/dist/index.d.mts'
  ]) {
    assertCondition(entries.has(required), `${packageName} archive is missing ${required}`)
  }
  if (requiresChangelog) {
    assertCondition(
      entries.has('package/CHANGELOG.md'),
      `${packageName} archive is missing CHANGELOG.md`
    )
  }
  assertCondition(
    ![...entries].some(
      (entry) =>
        entry.startsWith('package/src/') ||
        entry.startsWith('package/tests/') ||
        entry.includes('node_modules') ||
        entry.endsWith('.db')
    ),
    `${packageName} archive contains development files or a database`
  )
}

const install = async (fixture: string, archives: ArchiveSet): Promise<void> => {
  const artifacts = join(fixture, 'artifacts')
  await mkdir(artifacts)
  await cp(archives.core, join(artifacts, 'better-effect.tgz'))
  await cp(archives.kysely, join(artifacts, 'better-effect-kysely.tgz'))
  assertSuccess(run(['bun', 'install'], fixture), `Installing external consumer in ${fixture}`)

  const lockfile = await readFile(join(fixture, 'bun.lock'), 'utf8')
  assertCondition(
    !lockfile.includes('workspace:'),
    'Consumer lockfile contains a workspace reference'
  )
  assertCondition(
    !lockfile.includes('packages/better-effect'),
    'Consumer lockfile contains a source path'
  )
  assertCondition(
    lockfile.includes('better-effect-kysely') && lockfile.includes('better-effect'),
    'Consumer lockfile misses one of the packed packages'
  )
}

const readPackageVersion = async (path: string, packageName: string): Promise<string> => {
  // SAFETY: package.json is read from the archive or fixture under test and validated below.
  const manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')) as JsonValue
  assertCondition(isJsonObject(manifest), `${packageName} manifest is not an object`)
  const version = manifest['version']
  assertCondition(isJsonString(version), `${packageName} version is missing`)
  return version
}

const readInstalledVersion = async (fixture: string, packageName: string): Promise<string> =>
  readPackageVersion(join(fixture, 'node_modules', packageName), `Installed ${packageName}`)

const assertInstalledPackage = async (
  fixture: string,
  packageName: string,
  expectedVersion: string
): Promise<void> => {
  const installed = join(fixture, 'node_modules', packageName)
  const resolved = await realpath(installed)
  assertCondition(
    !resolved.startsWith(`${packageRoot}${sep}`) && !resolved.startsWith(`${coreRoot}${sep}`),
    `Consumer resolved ${packageName} from the workspace instead of the tarball`
  )
  assertCondition(
    (await readInstalledVersion(fixture, packageName)) === expectedVersion,
    `Consumer installed the wrong ${packageName} version`
  )
}

const typecheck = (fixture: string): void => {
  assertSuccess(
    run(['bun', 'x', 'tsc', '-p', 'tsconfig.json', '--pretty', 'false'], fixture),
    'External consumer current TypeScript typecheck'
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
        'tsconfig.json',
        '--pretty',
        'false'
      ],
      fixture
    ),
    'External consumer TypeScript 5.7.2 typecheck'
  )
}

const smoke = (runtime: 'bun' | 'node', fixture: string): void => {
  assertSuccess(
    run([runtime, 'smoke.mjs'], fixture),
    `External PGlite consumer smoke with ${runtime}`
  )
}

const sqliteSmoke = (fixture: string, runtime: RuntimeName): void => {
  assertSuccess(
    run([runtime, 'sqlite-smoke.mjs', runtime], fixture),
    `External ${runtime} SQLite consumer smoke`
  )
}

const assertNode24 = (): void => {
  const result = run(['node', '--version'], packageRoot)
  assertSuccess(result, 'Checking Node.js version')
  assertCondition(result.output.trim().startsWith('v24.'), 'The smoke test requires Node.js 24')
}

const reportVersions = async (fixture: string, label: string): Promise<void> => {
  const versions = await Promise.all([
    readInstalledVersion(fixture, 'better-effect'),
    readInstalledVersion(fixture, 'better-effect-kysely'),
    readInstalledVersion(fixture, 'better-result'),
    readInstalledVersion(fixture, 'kysely'),
    readInstalledVersion(fixture, 'typescript')
  ])
  const bun = run(['bun', '--version'], fixture).output.trim()
  const node = run(['node', '--version'], fixture).output.trim()
  console.log(
    `[external consumer:${label}] Bun ${bun}; Node ${node}; TypeScript ${versions[4]}; ` +
      `Kysely ${versions[3]}; better-effect ${versions[0]}; ` +
      `better-effect-kysely ${versions[1]}; better-result ${versions[2]}`
  )
}

const setKyselyVersion = async (fixture: string, version: string): Promise<void> => {
  const path = join(fixture, 'package.json')
  // SAFETY: package.json is the copied repository-controlled consumer fixture.
  const manifest = JSON.parse(await readFile(path, 'utf8')) as JsonValue
  if (!isJsonObject(manifest))
    throw new Error('External consumer package manifest is not an object')
  const dependencies = manifest['dependencies']
  if (!isJsonObject(dependencies)) throw new Error('External consumer dependencies are missing')
  await writeFile(
    path,
    `${JSON.stringify({ ...manifest, dependencies: { ...dependencies, kysely: version } }, null, 2)}\n`
  )
}

const runConsumer = async (
  root: string,
  source: string,
  archives: ArchiveSet,
  cell: VersionCell,
  runtime: RuntimeName | 'both',
  dialect: DialectName | 'both'
): Promise<void> => {
  const label = `${cell.label}-${runtime}-${dialect}`
  const fixture = join(root, label)
  await cp(source, fixture, { recursive: true })
  await setKyselyVersion(fixture, cell.spec)
  await install(fixture, archives)
  await assertInstalledPackage(
    fixture,
    'better-effect',
    await readPackageVersion(coreRoot, 'better-effect')
  )
  await assertInstalledPackage(fixture, 'better-effect-kysely', '0.1.0')
  assertCondition(
    (await readInstalledVersion(fixture, 'kysely')) === cell.expectedVersion,
    `Consumer did not resolve Kysely ${cell.expectedVersion}`
  )
  await reportVersions(fixture, label)
  typecheck(fixture)
  if (dialect === 'pglite' || dialect === 'both') {
    if (runtime === 'bun' || runtime === 'both') smoke('bun', fixture)
    if (runtime === 'node' || runtime === 'both') smoke('node', fixture)
  }
  if (dialect === 'sqlite' || dialect === 'both') {
    const sqliteRuntimes: RuntimeName[] = runtime === 'both' ? ['bun', 'node'] : [runtime]
    for (const sqliteRuntime of sqliteRuntimes) {
      sqliteSmoke(fixture, sqliteRuntime)
    }
  }
}

const runImportConsumer = async (root: string, archives: ArchiveSet): Promise<void> => {
  const fixture = join(root, 'import-only-consumer')
  await cp(importFixtureSource, fixture, { recursive: true })
  await install(fixture, archives)
  await assertInstalledPackage(
    fixture,
    'better-effect',
    await readPackageVersion(coreRoot, 'better-effect')
  )
  await assertInstalledPackage(fixture, 'better-effect-kysely', '0.1.0')
  await reportVersions(fixture, 'import-only')
  typecheck(fixture)
  assertSuccess(run(['bun', 'smoke.mjs'], fixture), 'Import-only consumer smoke with Bun')
  assertSuccess(run(['node', 'smoke.mjs'], fixture), 'Import-only consumer smoke with Node')
}

const main = async (): Promise<void> => {
  assertNode24()
  const root = await mkdtemp(join(tmpdir(), 'better-effect-kysely-consumer-'))
  const previousCache = process.env.BUN_INSTALL_CACHE_DIR
  process.env.BUN_INSTALL_CACHE_DIR = join(root, 'bun-cache')

  try {
    const archives = await packArtifacts(root)
    assertArchive(archives.core, 'better-effect', false)
    assertArchive(archives.kysely, 'better-effect-kysely', true)

    const coreVersion = await readPackageVersion(coreRoot, 'better-effect')
    const matrix: VersionCell[] = [
      { label: 'consumer-minimum', spec: '0.29.5', expectedVersion: '0.29.5' },
      // 0.29.5 is the latest release in the package's supported peer range.
      { label: 'consumer-current-tested', spec: '^0.29.5', expectedVersion: '0.29.5' }
    ]
    const requestedVersion = process.env['BETTER_EFFECT_KYSELY_VERSION_CELL']
    const requestedRuntime = process.env['BETTER_EFFECT_KYSELY_RUNTIME']
    const requestedDialect = process.env['BETTER_EFFECT_KYSELY_DIALECT']
    const selectedCells =
      requestedVersion === undefined
        ? matrix
        : matrix.filter((cell) => cell.label === requestedVersion)
    assertCondition(selectedCells.length > 0, `Unknown Kysely version cell: ${requestedVersion}`)
    const runtime: RuntimeName | 'both' =
      requestedRuntime === undefined || requestedRuntime === 'both'
        ? 'both'
        : requestedRuntime === 'bun' || requestedRuntime === 'node'
          ? requestedRuntime
          : (() => {
              throw new Error(`Unknown consumer runtime: ${requestedRuntime}`)
            })()
    const dialect: DialectName | 'both' =
      requestedDialect === undefined || requestedDialect === 'both'
        ? 'both'
        : requestedDialect === 'pglite' || requestedDialect === 'sqlite'
          ? requestedDialect
          : (() => {
              throw new Error(`Unknown consumer dialect: ${requestedDialect}`)
            })()
    for (const cell of selectedCells) {
      await runConsumer(root, fixtureSource, archives, cell, runtime, dialect)
    }
    if (
      requestedVersion === undefined &&
      requestedRuntime === undefined &&
      requestedDialect === undefined
    ) {
      await runImportConsumer(root, archives)
    }
    console.log(
      `better-effect-kysely external consumer checks passed for Kysely ${selectedCells
        .map((cell) => cell.expectedVersion)
        .join(', ')} with better-effect ${coreVersion}`
    )
  } finally {
    await rm(root, { force: true, recursive: true })
    if (previousCache === undefined) delete process.env.BUN_INSTALL_CACHE_DIR
    else process.env.BUN_INSTALL_CACHE_DIR = previousCache
  }
}

await main()
