import { cp, mkdtemp, mkdir, realpath, readdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))

const run = async (
  command: readonly string[],
  environment: Record<string, string | undefined> = process.env
): Promise<void> => {
  const child = Bun.spawn([...command], {
    cwd: packageRoot,
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

const runFreshPackedNodeTests = async (): Promise<void> => {
  await rm(join(packageRoot, 'dist'), { force: true, recursive: true })
  await run([process.execPath, 'run', 'build'])

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'better-effect-node-runtime-'))

  try {
    await run([
      process.execPath,
      'pm',
      'pack',
      '--destination',
      temporaryDirectory,
      '--ignore-scripts'
    ])
    const archive = await packageArchive(temporaryDirectory)
    const packageDirectory = await unpackPackage(archive, temporaryDirectory)
    const environment = {
      ...process.env,
      BETTER_EFFECT_NODE_RUNTIME_ENTRY: pathToFileURL(join(packageDirectory, 'dist/node.mjs')).href,
      BETTER_EFFECT_NODE_CORE_ENTRY: pathToFileURL(join(packageDirectory, 'dist/index.mjs')).href,
      BETTER_EFFECT_RESULT_ENTRY: pathToFileURL(
        resolve(packageDirectory, '../better-result/dist/index.mjs')
      ).href
    }

    await run([process.execPath, 'test', 'tests/runtime-node.test.ts'], environment)
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true })
  }
}

await runFreshPackedNodeTests()
console.log('Fresh packed Node/Bun NodeRuntime child tests passed')
