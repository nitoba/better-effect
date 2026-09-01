import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const fixtureSource = join(packageRoot, 'tests/package/consumer')
const decoder = new TextDecoder()

type CommandResult = {
  readonly exitCode: number
  readonly output: string
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

type JsonObject = { readonly [key: string]: JsonValue }

const assertCondition: (condition: boolean, message: string) => asserts condition = (
  condition,
  message
) => {
  if (!condition) throw new Error(message)
}

const isJsonObject = (value: JsonValue): value is JsonObject =>
  Object.prototype.toString.call(value) === '[object Object]'

const run = (command: string[], cwd: string): CommandResult => {
  const result = Bun.spawnSync(command, { cwd, stderr: 'pipe', stdout: 'pipe' })
  return {
    exitCode: result.exitCode,
    output: `${decoder.decode(result.stdout)}\n${decoder.decode(result.stderr)}`
  }
}

const assertSuccess = (result: CommandResult, label: string): void => {
  assertCondition(result.exitCode === 0, `${label} failed:\n${result.output}`)
}

const pack = async (root: string): Promise<string> => {
  const destination = join(root, 'archive')
  await mkdir(destination)
  assertSuccess(
    run(['bun', 'pm', 'pack', '--destination', destination, '--ignore-scripts'], packageRoot),
    'Packing better-effect-kysely'
  )
  const archives = (await readdir(destination)).filter((entry) => entry.endsWith('.tgz'))
  assertCondition(archives.length === 1, `Expected one package archive, found ${archives.length}`)
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

const assertArchive = (entries: readonly string[]): void => {
  const set = new Set(entries)
  for (const required of [
    'package/package.json',
    'package/LICENSE',
    'package/README.md',
    'package/CHANGELOG.md',
    'package/dist/index.mjs',
    'package/dist/index.d.mts'
  ]) {
    assertCondition(set.has(required), `Archive is missing ${required}`)
  }

  assertCondition(
    !entries.some(
      (entry) =>
        entry.startsWith('package/src/') ||
        entry.startsWith('package/tests/') ||
        entry.includes('node_modules') ||
        entry.endsWith('.db')
    ),
    'Archive contains development files or a database'
  )
}

const install = async (fixture: string, archive: string): Promise<void> => {
  const artifacts = join(fixture, 'artifacts')
  await mkdir(artifacts)
  await cp(archive, join(artifacts, 'better-effect-kysely.tgz'))
  assertSuccess(
    run(['bun', 'install', '--ignore-scripts'], fixture),
    'Installing external consumer'
  )

  const lockfile = await readFile(join(fixture, 'bun.lock'), 'utf8')
  assertCondition(
    !lockfile.includes('workspace:'),
    'Consumer lockfile contains a workspace reference'
  )
  assertCondition(lockfile.includes('better-effect-kysely'), 'Consumer lockfile misses the package')
}

const assertInstalledPackage = async (fixture: string): Promise<void> => {
  const installed = join(fixture, 'node_modules/better-effect-kysely')
  // SAFETY: package.json is parsed from the archive just installed by this fixture and is validated below.
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')) as JsonValue
  assertCondition(isJsonObject(manifest), 'Installed package manifest is not an object')
  assertCondition(
    manifest['name'] === 'better-effect-kysely',
    'Installed package has the wrong name'
  )
  assertCondition(manifest['version'] === '0.1.0', 'Installed package has the wrong version')
  const resolved = await realpath(installed)
  assertCondition(
    !resolved.startsWith(`${packageRoot}${sep}`),
    'Consumer resolved the workspace package instead of the tarball'
  )
}

const typecheck = (fixture: string): void => {
  assertSuccess(
    run(['bun', 'x', 'tsc', '-p', 'tsconfig.json', '--pretty', 'false'], fixture),
    'External consumer typecheck'
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
    'External consumer minimum TypeScript typecheck'
  )
}

const smoke = (runtime: 'bun' | 'node', fixture: string): void => {
  assertSuccess(run([runtime, 'smoke.mjs'], fixture), `External consumer smoke with ${runtime}`)
}

const assertNode24 = (): void => {
  const result = run(['node', '--version'], packageRoot)
  assertSuccess(result, 'Checking Node.js version')
  assertCondition(result.output.trim().startsWith('v24.'), 'The smoke test requires Node.js 24')
}

const main = async (): Promise<void> => {
  assertNode24()
  const root = await mkdtemp(join(tmpdir(), 'better-effect-kysely-consumer-'))
  const fixture = join(root, 'consumer')

  try {
    await cp(fixtureSource, fixture, { recursive: true })
    const archive = await pack(root)
    assertArchive(archiveEntries(archive))
    await install(fixture, archive)
    await assertInstalledPackage(fixture)
    typecheck(fixture)
    smoke('bun', fixture)
    smoke('node', fixture)
    console.log('better-effect-kysely external consumer checks passed')
  } finally {
    await rm(root, { force: true, recursive: true })
  }
}

await main()
