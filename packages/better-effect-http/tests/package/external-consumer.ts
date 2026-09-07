// oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- this script crosses packed artifact and subprocess boundaries.
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const corePackageRoot = resolve(packageRoot, '../better-effect')
const schemaPackageRoot = resolve(packageRoot, '../better-effect-schema')
const fixtureSource = join(packageRoot, 'tests/package/consumer')
const decoder = new TextDecoder()

type CommandResult = {
  readonly exitCode: number
  readonly output: string
}

const assertCondition: (condition: boolean, message: string) => asserts condition = (
  condition,
  message
) => {
  if (!condition) throw new Error(message)
}

const run = (command: string[], cwd: string): CommandResult => {
  const result = Bun.spawnSync(command, { cwd, stdout: 'pipe', stderr: 'pipe' })
  return {
    exitCode: result.exitCode,
    output: `${decoder.decode(result.stdout)}\n${decoder.decode(result.stderr)}`
  }
}

const assertSuccess = (result: CommandResult, label: string): void => {
  assertCondition(result.exitCode === 0, `${label} failed:\n${result.output}`)
}

const main = async (): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'better-effect-http-consumer-'))
  const previousCache = process.env['BUN_INSTALL_CACHE_DIR']
  process.env['BUN_INSTALL_CACHE_DIR'] = join(root, 'bun-cache')

  try {
    const archiveDirectory = join(root, 'archives')
    await mkdir(archiveDirectory)
    assertSuccess(
      run(['bun', 'run', 'build'], corePackageRoot),
      'Building better-effect for the external consumer'
    )
    assertSuccess(
      run(['bun', 'run', 'build'], schemaPackageRoot),
      'Building better-effect-schema for the external consumer'
    )
    assertSuccess(
      run(
        ['bun', 'pm', 'pack', '--destination', archiveDirectory, '--ignore-scripts'],
        corePackageRoot
      ),
      'Packing better-effect'
    )
    assertSuccess(
      run(
        ['bun', 'pm', 'pack', '--destination', archiveDirectory, '--ignore-scripts'],
        schemaPackageRoot
      ),
      'Packing better-effect-schema'
    )
    assertSuccess(
      run(
        ['bun', 'pm', 'pack', '--destination', archiveDirectory, '--ignore-scripts'],
        packageRoot
      ),
      'Packing better-effect-http'
    )
    const archiveName = (await readdir(archiveDirectory)).find(
      (entry) => entry.startsWith('better-effect-http-') && entry.endsWith('.tgz')
    )
    assertCondition(archiveName !== undefined, 'Package packing did not create an archive')
    const schemaArchiveName = (await readdir(archiveDirectory)).find(
      (entry) => entry.startsWith('better-effect-schema-') && entry.endsWith('.tgz')
    )
    assertCondition(
      schemaArchiveName !== undefined,
      'Schema package packing did not create an archive'
    )
    const coreArchiveName = (await readdir(archiveDirectory)).find(
      (entry) => entry === 'better-effect-0.13.0.tgz'
    )
    assertCondition(
      coreArchiveName !== undefined,
      'Package packing did not create a better-effect archive'
    )

    const fixture = join(root, 'fixture')
    await cp(fixtureSource, fixture, { recursive: true })
    await mkdir(join(fixture, 'artifacts'))
    await cp(join(archiveDirectory, coreArchiveName), join(fixture, 'artifacts', coreArchiveName))
    await cp(join(archiveDirectory, archiveName), join(fixture, 'artifacts/better-effect-http.tgz'))
    await cp(
      join(archiveDirectory, schemaArchiveName),
      join(fixture, 'artifacts', schemaArchiveName)
    )

    assertSuccess(
      run(['bun', 'install', '--ignore-scripts', '--omit=peer'], fixture),
      'Installing external consumer'
    )
    assertSuccess(
      run(['bun', 'x', 'tsc', '--noEmit', '-p', 'tsconfig.json'], fixture),
      'Typechecking external consumer'
    )
    assertSuccess(run(['bun', 'smoke.mjs'], fixture), 'Running Bun external consumer')

    const nodeProbe = run(['node', '--version'], fixture)
    if (nodeProbe.exitCode === 0) {
      assertSuccess(run(['node', 'smoke.mjs'], fixture), 'Running Node external consumer')
      console.log(`Node external consumer passed on ${nodeProbe.output.trim()}`)
    } else {
      console.log('Node external consumer skipped: node is not available in this environment')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
    if (previousCache === undefined) delete process.env['BUN_INSTALL_CACHE_DIR']
    else process.env['BUN_INSTALL_CACHE_DIR'] = previousCache
  }
}

await main()
