import { cp, mkdtemp, mkdir, realpath, readdir, rename, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))

const run = async (
  command: readonly string[],
  environment: Record<string, string | undefined> = process.env,
  cwd: string = packageRoot
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

const unpackPackage = async (archive: string, directory: string): Promise<string> => {
  const nodeModules = join(directory, 'consumer', 'node_modules')
  const packageDirectory = join(nodeModules, 'better-effect')

  await mkdir(nodeModules, { recursive: true })
  await run(['tar', '-xzf', archive, '-C', nodeModules])
  await rename(join(nodeModules, 'package'), packageDirectory)

  const betterResult = await realpath(join(packageRoot, 'node_modules/better-result'))
  await cp(betterResult, join(nodeModules, 'better-result'), {
    dereference: true,
    recursive: true
  })

  return packageDirectory
}

const freshPackageFiles = [
  'package.json',
  'README.md',
  'LICENSE',
  'tsdown.config.ts',
  'tsconfig.json'
] as const

const prepareFreshPackage = async (directory: string): Promise<void> => {
  await mkdir(directory, { recursive: true })
  await Promise.all(
    freshPackageFiles.map((file) => cp(join(packageRoot, file), join(directory, file)))
  )
  await cp(join(packageRoot, 'src'), join(directory, 'src'), {
    dereference: true,
    recursive: true
  })

  const packageNodeModules = join(packageRoot, 'node_modules')
  const freshNodeModules = join(directory, 'node_modules')
  await mkdir(freshNodeModules, { recursive: true })
  await Promise.all(
    (await readdir(packageNodeModules, { withFileTypes: true }))
      .filter((entry) => entry.name !== '.bin')
      .map((entry) =>
        symlink(
          join(packageNodeModules, entry.name),
          join(freshNodeModules, entry.name),
          entry.isDirectory() ? 'dir' : 'file'
        )
      )
  )
  await symlink(join(packageNodeModules, '.bin'), join(freshNodeModules, '.bin'), 'dir')
  await symlink(
    join(packageRoot, '../../node_modules/.bun/node_modules/@typescript'),
    join(freshNodeModules, '@typescript'),
    'dir'
  )
}

const runFreshPackedNodeRuntimeTests = async (): Promise<void> => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'better-effect-node-runtime-'))
  const freshPackageDirectory = join(temporaryDirectory, 'fresh-package')

  try {
    await prepareFreshPackage(freshPackageDirectory)
    await run([process.execPath, 'run', 'build'], process.env, freshPackageDirectory)
    await run(
      [process.execPath, 'pm', 'pack', '--destination', temporaryDirectory, '--ignore-scripts'],
      process.env,
      freshPackageDirectory
    )
    const archive = await packageArchive(temporaryDirectory)
    const packageDirectory = await unpackPackage(archive, temporaryDirectory)
    const environment = {
      ...process.env,
      BETTER_EFFECT_PACKED_RUNTIME_ENTRY: pathToFileURL(join(packageDirectory, 'dist/node.mjs'))
        .href,
      BETTER_EFFECT_PACKED_CORE_ENTRY: pathToFileURL(join(packageDirectory, 'dist/index.mjs')).href,
      BETTER_EFFECT_PACKED_RESULT_ENTRY: pathToFileURL(
        resolve(packageDirectory, '../better-result/dist/index.mjs')
      ).href,
      BETTER_EFFECT_PACKED_PACKAGE_DIRECTORY: packageDirectory
    }

    await run([process.execPath, 'test', 'tests/runtime-node.test.ts'], environment)
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true })
  }
}

await runFreshPackedNodeRuntimeTests()
console.log('Fresh packed Node/Bun NodeRuntime child tests passed')
