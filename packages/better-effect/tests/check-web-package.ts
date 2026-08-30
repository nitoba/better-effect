import { cp, mkdtemp, mkdir, realpath, readdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))
const childSource = join(packageRoot, 'tests/helpers/web-package-child.mjs')

const run = async (
  command: readonly string[],
  environment: Record<string, string | undefined> = process.env,
  cwd = packageRoot
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

const findArchive = async (directory: string): Promise<string> => {
  const archive = (await readdir(directory)).find(
    (entry) => entry.startsWith('better-effect-') && entry.endsWith('.tgz')
  )

  if (archive === undefined) {
    throw new Error('Fresh better-effect package archive was not created')
  }

  return join(directory, archive)
}

const unpackPackage = async (archive: string, directory: string): Promise<string> => {
  const consumer = join(directory, 'consumer')
  const nodeModules = join(consumer, 'node_modules')
  const packageDirectory = join(nodeModules, 'better-effect')

  await mkdir(nodeModules, { recursive: true })
  await run(['tar', '-xzf', archive, '-C', nodeModules])
  await rename(join(nodeModules, 'package'), packageDirectory)

  const betterResult = await realpath(join(packageRoot, 'node_modules/better-result'))
  await cp(betterResult, join(nodeModules, 'better-result'), {
    dereference: true,
    recursive: true
  })
  await cp(childSource, join(consumer, 'web-package-child.mjs'))

  return consumer
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'better-effect-web-package-'))

try {
  await rm(join(packageRoot, 'dist'), { force: true, recursive: true })
  await run([process.execPath, 'run', 'build'])
  await run([
    process.execPath,
    'pm',
    'pack',
    '--destination',
    temporaryDirectory,
    '--ignore-scripts'
  ])

  const archive = await findArchive(temporaryDirectory)
  const consumer = await unpackPackage(archive, temporaryDirectory)
  const child = join(consumer, 'web-package-child.mjs')
  const environment = {
    ...process.env,
    BETTER_EFFECT_EXPECTED_ARTIFACT: 'fresh-packed'
  }

  await run(['node', child], environment, consumer)
  await run([process.execPath, child], environment, consumer)
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true })
}

console.log('Fresh packed Node/Bun WebEffect package smoke tests passed')
