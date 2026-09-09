// oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- this script crosses packed artifact and subprocess boundaries.
import { createHash } from 'node:crypto'
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const repositoryRoot = resolve(packageRoot, '../..')
const corePackageRoot = resolve(packageRoot, '../better-effect')
const schemaPackageRoot = resolve(packageRoot, '../better-effect-schema')
const fixtureRoot = join(packageRoot, 'tests/package')
const decoder = new TextDecoder()

const versions = {
  '@opentelemetry/api': '1.9.1',
  '@types/node': '26.1.2',
  arktype: '2.2.3',
  'better-effect-http': '0.1.0',
  'better-effect-schema': '0.1.0',
  'better-result': '3.0.1',
  hono: '4.13.3',
  typescript: process.env['BETTER_EFFECT_HTTP_TYPESCRIPT_VERSION'] ?? '7.0.2',
  valibot: '1.4.2',
  zod: '4.5.4'
} as const

const optionalPackages = ['@opentelemetry/api', 'arktype', 'hono', 'valibot', 'zod'] as const

type PackageName = keyof typeof versions | 'better-effect'
type ExpectedVersions = Readonly<Record<PackageName, string>>
type ConsumerCase = Readonly<{
  readonly name: string
  readonly fixture: string
  readonly required: readonly PackageName[]
  readonly absent: readonly PackageName[]
}>

const cases: readonly ConsumerCase[] = [
  {
    name: 'generic',
    fixture: 'generic-consumer',
    required: [
      'better-effect',
      'better-effect-http',
      'better-effect-schema',
      'better-result',
      'typescript'
    ],
    absent: optionalPackages
  },
  {
    name: 'integrated',
    fixture: 'consumer',
    required: [
      '@types/node',
      'arktype',
      'better-effect',
      'better-effect-http',
      'better-effect-schema',
      'better-result',
      'hono',
      'typescript',
      'valibot',
      'zod'
    ],
    absent: ['@opentelemetry/api']
  },
  {
    name: 'telemetry',
    fixture: 'telemetry-consumer',
    required: [
      '@opentelemetry/api',
      'better-effect',
      'better-effect-http',
      'better-effect-schema',
      'better-result',
      'typescript'
    ],
    absent: ['arktype', 'hono', 'valibot', 'zod']
  }
]

type JsonObject = { readonly [key: string]: unknown }
type PackageManifest = JsonObject & {
  readonly name?: string
  readonly version?: string
  readonly dependencies?: JsonObject
  readonly devDependencies?: JsonObject
  readonly overrides?: JsonObject
  readonly exports?: JsonObject
  readonly peerDependenciesMeta?: JsonObject
}
type CommandResult = Readonly<{
  readonly exitCode: number
  readonly output: string
}>

const assertCondition: (condition: boolean, message: string) => asserts condition = (
  condition,
  message
) => {
  if (!condition) throw new Error(message)
}

const run = (command: readonly string[], cwd: string): CommandResult => {
  const result = Bun.spawnSync({ cmd: [...command], cwd, stdout: 'pipe', stderr: 'pipe' })
  return {
    exitCode: result.exitCode,
    output: `${decoder.decode(result.stdout)}\n${decoder.decode(result.stderr)}`
  }
}

const assertSuccess = (result: CommandResult, label: string): void => {
  assertCondition(result.exitCode === 0, `${label} failed:\n${result.output}`)
}

const readManifest = async (path: string): Promise<PackageManifest> => {
  // SAFETY: package.json is a repository-controlled or freshly installed package manifest.
  return JSON.parse(await readFile(path, 'utf8')) as PackageManifest
}

const readPackageVersion = async (
  packageDirectory: string,
  packageName: string
): Promise<string> => {
  const manifest = await readManifest(join(packageDirectory, 'package.json'))
  assertCondition(manifest.name === packageName, `${packageName} manifest has the wrong name`)
  const version = manifest.version
  assertCondition(
    typeof version === 'string' && version.length > 0,
    `${packageName} manifest is missing a version`
  )
  return version
}

const packageExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

const assertNoWorkspaceLinks = async (directory: string): Promise<void> => {
  const workspacePrefix = repositoryRoot.endsWith(sep) ? repositoryRoot : `${repositoryRoot}${sep}`
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      const target = await realpath(path)
      assertCondition(
        target !== repositoryRoot && !target.startsWith(workspacePrefix),
        `External consumer links into the workspace: ${path} -> ${target}`
      )
    } else if (entry.isDirectory()) {
      await assertNoWorkspaceLinks(path)
    }
  }
}

const archiveEntries = (archive: string): string[] => {
  const result = run(['tar', '-tzf', archive], repositoryRoot)
  assertSuccess(result, `Listing ${archive}`)
  return result.output
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort()
}

const pack = async (
  packageDirectory: string,
  archiveRoot: string,
  label: string
): Promise<string> => {
  const destination = join(archiveRoot, label)
  await mkdir(destination)
  const result = run(
    ['bun', 'pm', 'pack', '--destination', destination, '--ignore-scripts'],
    packageDirectory
  )
  assertSuccess(result, `Packing ${packageDirectory}`)
  const archives = (await readdir(destination)).filter((entry) => entry.endsWith('.tgz'))
  assertCondition(archives.length === 1, `Expected one ${label} archive`)
  const archive = archives[0]
  assertCondition(archive !== undefined, `Packed ${label} archive name was not returned`)
  return join(destination, archive)
}

const assertPackedArtifact = async (archive: string): Promise<void> => {
  const entries = archiveEntries(archive)
  for (const required of [
    'package/package.json',
    'package/LICENSE',
    'package/README.md',
    'package/CHANGELOG.md',
    'package/VERIFICATION.md',
    'package/dist/index.mjs',
    'package/dist/index.d.mts',
    'package/dist/endpoints.mjs',
    'package/dist/endpoints.d.mts',
    'package/dist/opentelemetry.mjs',
    'package/dist/opentelemetry.d.mts',
    'package/dist/testing.mjs',
    'package/dist/testing.d.mts'
  ]) {
    assertCondition(entries.includes(required), `Packed archive is missing ${required}`)
  }
  assertCondition(
    !entries.some((entry) =>
      /(?:^|\/)(?:node_modules|src|tests|examples|\.git)(?:\/|$)/u.test(entry)
    ),
    `Packed archive contains workspace-only files: ${entries.join(', ')}`
  )

  const digest = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex')
  console.log(`better-effect-http archive sha256: ${digest}`)
}

const assertInstalledPackage = async (
  fixture: string,
  name: PackageName,
  expectedVersion: string
): Promise<void> => {
  const installed = join(fixture, 'node_modules', name)
  const manifest = await readManifest(join(installed, 'package.json'))
  assertCondition(manifest.name === name, `Installed package has the wrong name for ${name}`)
  assertCondition(
    manifest.version === expectedVersion,
    `${name} must be installed at ${expectedVersion}, got ${String(manifest.version)}`
  )
  const resolved = await realpath(installed)
  assertCondition(
    resolved !== repositoryRoot && !resolved.startsWith(`${repositoryRoot}${sep}`),
    `${name} resolved through the monorepo instead of the isolated consumer`
  )
}

const assertManifestExports = async (fixture: string): Promise<void> => {
  const manifest = await readManifest(join(fixture, 'node_modules/better-effect-http/package.json'))
  const exports = manifest.exports
  assertCondition(exports !== undefined, 'Packed HTTP manifest has no export map')
  for (const target of Object.values(exports)) {
    if (typeof target !== 'string' || !target.startsWith('./')) continue
    assertCondition(
      await packageExists(join(fixture, 'node_modules/better-effect-http', target.slice(2))),
      `Packed HTTP export target is missing: ${target}`
    )
  }
  assertCondition(
    manifest.peerDependenciesMeta?.['@opentelemetry/api'] !== undefined,
    'Packed HTTP manifest lost optional OpenTelemetry peer metadata'
  )
}

const installCase = async (
  root: string,
  currentCase: ConsumerCase,
  archives: Readonly<Record<string, string>>,
  coreVersion: string
): Promise<string> => {
  const fixture = join(root, currentCase.name)
  await cp(join(fixtureRoot, currentCase.fixture), fixture, { recursive: true })
  const artifacts = join(fixture, 'artifacts')
  await mkdir(artifacts)
  const caseArchiveNames = ['core', 'http', 'schema']
  for (const archiveName of caseArchiveNames) {
    const archive = archives[archiveName]
    assertCondition(archive !== undefined, `Missing ${archiveName} archive`)
    const fileName =
      archiveName === 'http'
        ? 'better-effect-http.tgz'
        : archiveName === 'core'
          ? `better-effect-${coreVersion}.tgz`
          : 'better-effect-schema-0.1.0.tgz'
    await cp(archive, join(artifacts, fileName))
  }

  const manifest = await readManifest(join(fixture, 'package.json'))
  const coreReference = `file:./artifacts/better-effect-${coreVersion}.tgz`
  const dependencies = { ...manifest.dependencies }
  const overrides = { ...manifest.overrides }
  assertCondition(
    dependencies['better-effect'] !== undefined,
    `${currentCase.name} fixture must declare better-effect`
  )
  assertCondition(
    overrides['better-effect'] !== undefined,
    `${currentCase.name} fixture must override better-effect`
  )
  dependencies['better-effect'] = coreReference
  overrides['better-effect'] = coreReference
  const devDependencies = { ...manifest.devDependencies, typescript: versions.typescript }
  await writeFile(
    join(fixture, 'package.json'),
    `${JSON.stringify({ ...manifest, dependencies, devDependencies, overrides }, null, 2)}\n`
  )

  assertSuccess(
    run(['bun', 'install', '--omit=peer', '--ignore-scripts'], fixture),
    `Installing ${currentCase.name} external consumer`
  )
  assertSuccess(
    run(['bun', 'install', '--frozen-lockfile', '--omit=peer', '--ignore-scripts'], fixture),
    `Reinstalling ${currentCase.name} external consumer from its lockfile`
  )
  return fixture
}

const assertCaseDependencies = async (
  fixture: string,
  currentCase: ConsumerCase,
  expectedVersions: ExpectedVersions
): Promise<void> => {
  for (const dependency of currentCase.required) {
    await assertInstalledPackage(fixture, dependency, expectedVersions[dependency])
  }
  const modules = join(fixture, 'node_modules')
  for (const dependency of currentCase.absent) {
    assertCondition(
      !(await packageExists(join(modules, dependency))),
      `${currentCase.name} unexpectedly installed ${dependency}`
    )
  }
  await assertNoWorkspaceLinks(modules)
}

const typecheck = (fixture: string, currentCase: ConsumerCase): void => {
  assertSuccess(
    run(
      [
        'bun',
        join(fixture, 'node_modules/typescript/bin/tsc'),
        '-p',
        'tsconfig.json',
        '--pretty',
        'false'
      ],
      fixture
    ),
    `Typechecking ${currentCase.name} external consumer with TypeScript ${versions.typescript}`
  )
}

const smoke = (fixture: string, currentCase: ConsumerCase): void => {
  assertSuccess(run(['bun', 'smoke.mjs'], fixture), `Running Bun ${currentCase.name} consumer`)
  assertSuccess(run(['node', 'smoke.mjs'], fixture), `Running Node ${currentCase.name} consumer`)
}

const main = async (): Promise<void> => {
  const nodeProbe = run(['node', '--version'], packageRoot)
  assertSuccess(nodeProbe, 'Checking the Node.js runtime')
  const nodeVersion = nodeProbe.output.trim()
  const nodeMajor = Number(/^v(\d+)/u.exec(nodeVersion)?.[1])
  assertCondition(
    Number.isFinite(nodeMajor) && nodeMajor >= 24,
    `Current Node.js LTS is required; found ${nodeVersion}`
  )
  console.log(
    `consumer runtime matrix: Bun ${Bun.version}, Node ${nodeVersion}, TypeScript ${versions.typescript}`
  )

  const root = await mkdtemp(join(tmpdir(), 'better-effect-http-consumers-'))
  const previousCache = process.env['BUN_INSTALL_CACHE_DIR']
  process.env['BUN_INSTALL_CACHE_DIR'] = join(root, 'bun-cache')

  try {
    const coreVersion = await readPackageVersion(corePackageRoot, 'better-effect')
    const archiveRoot = join(root, 'archives')
    await mkdir(archiveRoot)
    const archives = {
      core: await pack(corePackageRoot, archiveRoot, 'core'),
      schema: await pack(schemaPackageRoot, archiveRoot, 'schema'),
      http: await pack(packageRoot, archiveRoot, 'http')
    }
    await assertPackedArtifact(archives.http)

    for (const currentCase of cases) {
      const fixture = await installCase(root, currentCase, archives, coreVersion)
      await assertCaseDependencies(fixture, currentCase, {
        ...versions,
        'better-effect': coreVersion
      })
      await assertManifestExports(fixture)
      typecheck(fixture, currentCase)
      smoke(fixture, currentCase)
      console.log(
        `${currentCase.name}: isolated installation, declarations, Bun, and Node smoke passed`
      )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
    if (previousCache === undefined) delete process.env['BUN_INSTALL_CACHE_DIR']
    else process.env['BUN_INSTALL_CACHE_DIR'] = previousCache
  }

  console.log(`External HTTP tarball consumer matrix passed: ${cases.length} isolated cells.`)
}

await main()
