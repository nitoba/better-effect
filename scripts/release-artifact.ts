import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

type ReleaseConfig = {
  readonly directory: string
  readonly expectedEntries: readonly string[]
  readonly includeAllDistFiles: boolean
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const configs: Record<string, ReleaseConfig> = {
  'better-effect': {
    directory: 'packages/better-effect',
    expectedEntries: ['package/LICENSE', 'package/README.md', 'package/package.json'],
    includeAllDistFiles: true
  },
  'better-effect-better-auth': {
    directory: 'packages/better-effect-better-auth',
    expectedEntries: [
      'package/CHANGELOG.md',
      'package/LICENSE',
      'package/README.md',
      'package/dist/hooks.d.mts',
      'package/dist/hooks.d.mts.map',
      'package/dist/hooks.mjs',
      'package/dist/hooks.mjs.map',
      'package/dist/index.d.mts',
      'package/dist/index.d.mts.map',
      'package/dist/index.mjs',
      'package/dist/index.mjs.map',
      'package/package.json'
    ],
    includeAllDistFiles: false
  }
}

type JsonRecord = Record<string, unknown>

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

const readJson = (value: string, label: string): JsonRecord => {
  const parsed: unknown = JSON.parse(value)

  assertCondition(parsed !== null && typeof parsed === 'object', `${label} must be an object`)
  return parsed as JsonRecord
}

const archiveEntries = (archive: string): string[] =>
  run(['tar', '-tzf', archive], repositoryRoot)
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .sort()

const distEntries = async (packageRoot: string): Promise<string[]> => {
  const files: string[] = []
  const pending = [join(packageRoot, 'dist')]

  while (pending.length > 0) {
    const directory = pending.pop()
    if (directory === undefined) continue

    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile()) files.push(`package/dist/${relative(join(packageRoot, 'dist'), path)}`)
    }
  }

  return files.sort()
}

const assertSourceMap = (archive: string, name: string): void => {
  const map = readJson(run(['tar', '-xOf', archive, `package/${name}`], repositoryRoot), name)
  const sources = map['sources']

  assertCondition(Array.isArray(sources), `${name} must contain a sources array`)
  for (const source of sources) {
    assertCondition(typeof source === 'string', `${name} contains a non-string source`)
    assertCondition(
      !source.startsWith('/') && !source.includes('node_modules') && !source.includes('/tmp/'),
      `${name} leaks a private source path: ${source}`
    )
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
  assertCondition(value !== undefined && configs[value] !== undefined, `Package is not allowlisted: ${value}`)
  return value
}

const main = async (): Promise<void> => {
  const packageName = packageNameFromArgs()
  const config = configs[packageName]!
  const packageRoot = join(repositoryRoot, config.directory)
  const packageManifest = readJson(await readFile(join(packageRoot, 'package.json'), 'utf8'), 'package.json')
  const version = packageManifest['version']

  assertCondition(packageManifest['name'] === packageName, `Manifest name is not ${packageName}`)
  assertCondition(typeof version === 'string' && version.length > 0, 'Manifest version is missing')
  assertCondition(packageManifest['type'] === 'module', 'Published package must be ESM')
  assertCondition(packageManifest['sideEffects'] === false, 'Published package must be side-effect free')
  const temporaryRoot = await mkdtemp(join(tmpdir(), `${packageName}-release-`))
  try {
    run(['bun', 'pm', 'pack', '--destination', temporaryRoot, '--ignore-scripts'], packageRoot)
    const archives = (await readdir(temporaryRoot)).filter((entry) => entry.endsWith('.tgz'))
    assertCondition(archives.length === 1, `Expected one ${packageName} archive`)

    const archiveName = archives[0]!
    assertCondition(archiveName === `${packageName}-${version}.tgz`, `Unexpected archive name: ${archiveName}`)
    const archive = join(temporaryRoot, archiveName)
    const actualEntries = archiveEntries(archive)
    const expectedEntries = [
      ...config.expectedEntries,
      ...(config.includeAllDistFiles ? await distEntries(packageRoot) : [])
    ].sort()

    assertCondition(
      JSON.stringify(actualEntries) === JSON.stringify(expectedEntries),
      `Archive contents changed: ${actualEntries.join(', ')}`
    )

    const packedManifest = readJson(
      run(['tar', '-xOf', archive, 'package/package.json'], repositoryRoot),
      'packed package.json'
    )
    assertCondition(packedManifest['name'] === packageName, 'Packed manifest has the wrong name')
    assertCondition(packedManifest['version'] === version, 'Packed manifest has the wrong version')
    assertCondition(
      !JSON.stringify(packedManifest).includes('workspace:'),
      'Packed manifest contains a workspace dependency marker'
    )
    assertCondition(
      !JSON.stringify(packedManifest).includes('file:'),
      'Packed manifest contains a local file dependency'
    )
    for (const entry of actualEntries.filter((item) => item.endsWith('.map'))) {
      assertSourceMap(archive, entry.slice('package/'.length))
    }

    console.log(`release artifact validation passed for ${packageName}@${version}`)
    console.log(`archive: ${relative(repositoryRoot, archive).split(sep).join('/')}`)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

await main().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.message : cause)
  process.exitCode = 1
})
