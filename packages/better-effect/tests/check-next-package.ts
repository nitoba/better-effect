import { cp, lstat, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))
const fixtureRoot = join(packageRoot, 'tests/fixtures/next-app')
const testedNextVersion = '16.3.0'

const assertCondition: (condition: boolean, message: string) => asserts condition = (
  condition,
  message
) => {
  if (!condition) {
    throw new Error(message)
  }
}

const run = async (
  command: readonly string[],
  cwd = packageRoot,
  environment: Record<string, string | undefined> = process.env
): Promise<void> => {
  const child = Bun.spawn([...command], {
    cwd,
    env: environment,
    stdout: 'inherit',
    stderr: 'inherit'
  })
  const exitCode = await child.exited

  if (exitCode !== 0) {
    throw new Error(`Command failed with exit code ${exitCode}: ${command.join(' ')}`)
  }
}

const packageArchive = async (directory: string): Promise<string> => {
  const archive = (await readdir(directory)).find(
    (entry) => entry.startsWith('better-effect-') && entry.endsWith('.tgz')
  )

  if (archive === undefined) {
    throw new Error('Fresh better-effect package archive was not created')
  }

  return join(directory, archive)
}

const localBinary = (directory: string, name: string): string =>
  join(directory, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name)

// SAFETY: package.json is the repository-controlled manifest read at this package boundary.
const packageManifest = JSON.parse(await Bun.file(join(packageRoot, 'package.json')).text()) as {
  readonly version?: string
  readonly exports?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly peerDependenciesMeta?: Record<string, { readonly optional?: boolean }>
}

const assertBuiltPackage = async (): Promise<void> => {
  assertCondition(
    packageManifest.exports?.['./next'] === './dist/next.mjs',
    'Missing ./next export'
  )
  assertCondition(
    packageManifest.peerDependencies?.next === testedNextVersion,
    `Next peer range must match the tested Next.js version (${testedNextVersion})`
  )
  assertCondition(
    packageManifest.peerDependenciesMeta?.next?.optional === true,
    'Next must remain an optional peer dependency'
  )
  assertCondition(packageManifest.version !== undefined, 'Package version is missing')
  assertCondition(
    await Bun.file(join(packageRoot, 'dist/next.mjs')).exists(),
    'Missing next runtime build'
  )
  assertCondition(
    await Bun.file(join(packageRoot, 'dist/next.d.mts')).exists(),
    'Missing next declaration build'
  )

  const nextDeclaration = await Bun.file(join(packageRoot, 'dist/next.d.mts')).text()
  for (const member of ['Options', 'RouteOptions', 'Context', 'Handler']) {
    assertCondition(
      new RegExp(`\\btype\\s+${member}(?:\\s*<|\\s*=)`).test(nextDeclaration),
      `Missing NextEffect.${member} declaration`
    )
  }

  const nextRuntime = await import(pathToFileURL(join(packageRoot, 'dist/next.mjs')).href)
  assertCondition(nextRuntime.NextEffect !== undefined, 'Missing NextEffect runtime export')
  for (const member of ['Options', 'RouteOptions', 'Context', 'Handler']) {
    assertCondition(
      !Object.prototype.hasOwnProperty.call(nextRuntime.NextEffect, member),
      `NextEffect.${member} type alias leaked to runtime`
    )
  }

  const mainRuntime = await Bun.file(join(packageRoot, 'dist/index.mjs')).text()
  assertCondition(!/\bnext(?:\/|["'])/iu.test(mainRuntime), 'Main entrypoint imports Next')
}

const copyFixture = async (consumer: string): Promise<void> => {
  await cp(join(fixtureRoot, 'app'), join(consumer, 'app'), { recursive: true })
  for (const file of ['next-env.d.ts', 'next.config.mjs', 'tsconfig.json']) {
    await cp(join(fixtureRoot, file), join(consumer, file))
  }
}

const installFixture = async (consumer: string, archive: string): Promise<void> => {
  await Bun.write(
    join(consumer, 'package.json'),
    JSON.stringify(
      {
        name: 'better-effect-next-fixture-consumer',
        private: true,
        type: 'module',
        dependencies: {
          'better-effect': `file:${archive}`,
          'better-result': '3.0.0',
          next: testedNextVersion,
          react: '19.2.8',
          'react-dom': '19.2.8'
        },
        devDependencies: {
          '@types/node': '26.2.0',
          '@types/react': '19.2.18',
          typescript: '7.0.2'
        }
      },
      null,
      2
    )
  )

  const environment = { ...process.env }
  delete environment.NODE_PATH
  await run([process.execPath, 'install', '--no-progress'], consumer, environment)

  const installedPackage = join(consumer, 'node_modules', 'better-effect')
  const installedPackageStat = await lstat(installedPackage)
  assertCondition(
    !installedPackageStat.isSymbolicLink(),
    'Packed package was installed as a symlink'
  )
  assertCondition(
    (await realpath(installedPackage)) !== (await realpath(packageRoot)),
    'Packed fixture resolved better-effect from the source package'
  )
  assertCondition(
    await Bun.file(join(installedPackage, 'package.json')).exists(),
    'Packed fixture did not install better-effect'
  )
}

const runInstalledFixture = async (consumer: string): Promise<void> => {
  const next = localBinary(consumer, 'next')
  const typescript = localBinary(consumer, 'tsc')
  const environment = { ...process.env, NODE_PATH: undefined, NEXT_TELEMETRY_DISABLED: '1' }

  await run([next, 'typegen'], consumer, environment)
  await run([typescript, '--noEmit', '--pretty', 'false'], consumer, environment)
  await run([next, 'build'], consumer, environment)

  await cp(
    join(packageRoot, 'tests/helpers/next-package-child.mjs'),
    join(consumer, 'next-package-child.mjs')
  )
  await run(['node', 'next-package-child.mjs'], consumer, environment)
  await run([process.execPath, 'next-package-child.mjs'], consumer, environment)
}

const runFreshPackedNextChecks = async (): Promise<void> => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'better-effect-next-package-'))

  try {
    await rm(join(packageRoot, 'dist'), { force: true, recursive: true })
    await run([process.execPath, 'run', 'build'])
    await assertBuiltPackage()

    const archiveDirectory = join(temporaryDirectory, 'archive')
    await mkdir(archiveDirectory, { recursive: true })
    await run([
      process.execPath,
      'pm',
      'pack',
      '--destination',
      archiveDirectory,
      '--ignore-scripts'
    ])
    const archive = await packageArchive(archiveDirectory)
    const consumer = join(temporaryDirectory, 'consumer')
    await mkdir(consumer, { recursive: true })
    await copyFixture(consumer)
    await installFixture(consumer, archive)
    await runInstalledFixture(consumer)
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true })
  }
}

await runFreshPackedNextChecks()
await run([process.execPath, 'run', 'test:package-next'])

console.log('Fresh packed NextEffect package and App Router fixture checks passed')
