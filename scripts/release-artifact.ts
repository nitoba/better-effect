import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

type ReleaseRoute = {
  readonly name: string
  readonly directory: string
  readonly changelog: string
  readonly additionalFiles?: readonly string[]
}

type ReleaseRoutes = {
  readonly packages: readonly ReleaseRoute[]
}

type ReleaseConfig = {
  readonly directory: string
  readonly expectedEntries: readonly string[]
  readonly includeAllDistFiles: boolean
}

type ExportValue = string | Readonly<Record<string, ExportValue>>
type PackageManifest = {
  readonly name?: string
  readonly version?: string
  readonly type?: string
  readonly sideEffects?: boolean
  readonly exports?: Readonly<Record<string, ExportValue>>
}
type SourceMap = {
  readonly sources?: readonly string[]
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// SAFETY: release-packages.json is repository-controlled release configuration.
const releaseRoutes = JSON.parse(
  await readFile(resolve(repositoryRoot, 'scripts/release-packages.json'), 'utf8')
) as ReleaseRoutes
const configs: Record<string, ReleaseConfig> = Object.fromEntries(
  releaseRoutes.packages.map((route) => [
    route.name,
    {
      directory: route.directory,
      expectedEntries: [
        'package/LICENSE',
        'package/README.md',
        'package/package.json',
        ...(route.changelog === 'CHANGELOG.md' ? [] : ['package/CHANGELOG.md']),
        ...(route.additionalFiles ?? []).map((file) => `package/${file}`)
      ],
      includeAllDistFiles: true
    }
  ])
)

const fail = (message: string): never => {
  throw new Error(message)
}

const assertCondition = (condition: boolean, message: string): void => {
  if (!condition) {
    fail(message)
  }
}

const run = (command: string[], cwd: string): string => {
  const result = Bun.spawnSync({
    cmd: command,
    cwd,
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const output = `${result.stdout.toString()}\n${result.stderr.toString()}`

  assertCondition(result.exitCode === 0, `${command.join(' ')} failed:\n${output}`)
  return output
}

const archiveEntries = (archive: string): string[] =>
  run(['tar', '-tzf', archive], repositoryRoot)
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .sort()

const pack = async (
  packageRoot: string,
  destination: string,
  command: string[],
  label: string
): Promise<string> => {
  run([...command, '--ignore-scripts'], packageRoot)
  const archives = (await readdir(destination)).filter((entry) => entry.endsWith('.tgz'))
  assertCondition(archives.length === 1, `Expected one ${label} archive`)
  return join(destination, archives[0]!)
}

const distEntries = async (packageRoot: string): Promise<string[]> => {
  const files: string[] = []
  const pending = [join(packageRoot, 'dist')]

  while (pending.length > 0) {
    const directory = pending.pop()
    if (directory === undefined) continue

    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile())
        files.push(`package/dist/${relative(join(packageRoot, 'dist'), path).split(sep).join('/')}`)
    }
  }

  return files.sort()
}

const isStringValue = (value: ExportValue): value is string =>
  Object.prototype.toString.call(value) === '[object String]'

const requiredDistEntries = (manifest: PackageManifest): string[] => {
  const exportsValue = manifest.exports
  if (
    exportsValue === undefined ||
    Object.prototype.toString.call(exportsValue) !== '[object Object]'
  ) {
    fail('Published package exports must be an object')
  }
  const entries = new Set<string>()
  const visit = (value: ExportValue): void => {
    if (isStringValue(value)) {
      if (value.startsWith('./dist/') && value.endsWith('.mjs')) {
        const packageTarget = `package/${value.slice(2)}`
        entries.add(packageTarget)
        entries.add(packageTarget.replace(/\.mjs$/, '.d.mts'))
      }
      return
    }
    for (const child of Object.values(value)) visit(child)
  }

  visit(exportsValue)
  return [...entries].sort()
}

const assertSourceMap = (archive: string, name: string): void => {
  // SAFETY: the tar entry is parsed JSON; the checks below validate its source list before use.
  const map = JSON.parse(
    run(['tar', '-xOf', archive, `package/${name}`], repositoryRoot)
  ) as SourceMap
  const sources = map.sources

  assertCondition(Array.isArray(sources), `${name} must contain a sources array`)
  for (const source of sources) {
    assertCondition(isStringValue(source), `${name} contains a non-string source`)
    assertCondition(
      !source.startsWith('/') && !source.includes('node_modules') && !source.includes('/tmp/'),
      `${name} leaks a private source path: ${source}`
    )
  }
}

const assertArchive = async (
  archive: string,
  packageName: string,
  version: string,
  config: ReleaseConfig,
  packageRoot: string,
  packageManifest: PackageManifest,
  packer: string
): Promise<void> => {
  const archiveName = basename(archive)
  assertCondition(
    archiveName === `${packageName}-${version}.tgz`,
    `Unexpected ${packer} archive name: ${archiveName}`
  )
  const actualEntries = archiveEntries(archive)
  const expectedEntries = [
    ...new Set([
      ...config.expectedEntries,
      ...requiredDistEntries(packageManifest),
      ...(config.includeAllDistFiles ? await distEntries(packageRoot) : [])
    ])
  ].sort()

  assertCondition(
    JSON.stringify(actualEntries) === JSON.stringify(expectedEntries),
    `${packer} archive contents changed: ${actualEntries.join(', ')}`
  )

  // SAFETY: the packed manifest was produced from the repository-controlled package manifest.
  const packedManifest = JSON.parse(
    run(['tar', '-xOf', archive, 'package/package.json'], repositoryRoot)
  ) as PackageManifest
  assertCondition(packedManifest.name === packageName, `${packer} manifest has the wrong name`)
  assertCondition(packedManifest.version === version, `${packer} manifest has the wrong version`)
  const serializedManifest = JSON.stringify(packedManifest)
  assertCondition(
    !serializedManifest.includes('workspace:') &&
      !serializedManifest.includes('file:') &&
      !serializedManifest.includes('link:'),
    `${packer} packed manifest contains a local dependency marker`
  )
  for (const entry of actualEntries.filter((item) => item.endsWith('.map'))) {
    assertSourceMap(archive, entry.slice('package/'.length))
  }
}

const packageNameFromArgs = (): string => {
  const args = process.argv.slice(2)
  const value = args[0]?.startsWith('--package=')
    ? args[0].slice('--package='.length)
    : args[0] === '--package'
      ? args[1]
      : undefined

  assertCondition(args.length === (args[0] === '--package' ? 2 : 1), 'Usage: --package <name>')
  assertCondition(
    value !== undefined && configs[value] !== undefined,
    `Package is not allowlisted: ${value}`
  )
  return value
}

const main = async (): Promise<void> => {
  const packageName = packageNameFromArgs()
  const config = configs[packageName]!
  const packageRoot = join(repositoryRoot, config.directory)
  // SAFETY: package.json is a repository-controlled manifest with the package contract below.
  const packageManifest = JSON.parse(
    await readFile(join(packageRoot, 'package.json'), 'utf8')
  ) as PackageManifest
  const version = packageManifest.version

  assertCondition(packageManifest.name === packageName, `Manifest name is not ${packageName}`)
  assertCondition(
    version !== undefined && isStringValue(version) && version.length > 0,
    'Manifest version is missing'
  )
  assertCondition(packageManifest.type === 'module', 'Published package must be ESM')
  assertCondition(
    packageManifest.sideEffects === false,
    'Published package must be side-effect free'
  )
  const temporaryRoot = await mkdtemp(join(tmpdir(), `${packageName}-release-`))
  try {
    const packers = [
      {
        name: 'bun',
        directory: join(temporaryRoot, 'bun'),
        command: ['bun', 'pm', 'pack', '--destination', join(temporaryRoot, 'bun')]
      },
      {
        name: 'npm',
        directory: join(temporaryRoot, 'npm'),
        command: ['npm', 'pack', '--pack-destination', join(temporaryRoot, 'npm')]
      }
    ]
    for (const packer of packers) {
      await mkdir(packer.directory, { recursive: true })
      const archive = await pack(packageRoot, packer.directory, packer.command, packer.name)
      await assertArchive(
        archive,
        packageName,
        version,
        config,
        packageRoot,
        packageManifest,
        packer.name
      )
      console.log(
        `${packer.name} archive validated: ${relative(repositoryRoot, archive).split(sep).join('/')}`
      )
    }

    console.log(`release artifact validation passed for ${packageName}@${version}`)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

await main().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.message : cause)
  process.exitCode = 1
})
