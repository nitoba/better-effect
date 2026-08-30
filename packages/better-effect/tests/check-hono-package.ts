import { cp, mkdtemp, mkdir, realpath, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))
const childSource = join(packageRoot, 'tests/helpers/hono-package-child.mjs')

const run = async (
  command: readonly string[],
  cwd: string,
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

const copyDependency = async (
  consumerNodeModules: string,
  dependency: string,
  source: string
): Promise<void> => {
  const destination = join(consumerNodeModules, dependency)
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, { dereference: true, recursive: true })
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

const createConsumer = async (root: string, archive: string): Promise<string> => {
  const consumer = join(root, 'consumer')
  const nodeModules = join(consumer, 'node_modules')
  const packageDirectory = join(nodeModules, 'better-effect')

  await mkdir(nodeModules, { recursive: true })
  await writeFile(join(consumer, 'package.json'), '{"type":"module"}\n')
  await run(['tar', '-xzf', archive, '-C', nodeModules], packageRoot)
  await rename(join(nodeModules, 'package'), packageDirectory)

  const betterResult = await realpath(join(packageRoot, 'node_modules/better-result'))
  const hono = await realpath(join(packageRoot, 'node_modules/hono'))

  await copyDependency(nodeModules, 'better-result', betterResult)
  await copyDependency(nodeModules, 'hono', hono)
  await cp(childSource, join(consumer, 'hono-package-child.mjs'))

  return consumer
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'better-effect-hono-package-'))

try {
  await rm(join(packageRoot, 'dist'), { force: true, recursive: true })
  await run([process.execPath, 'run', 'build'], packageRoot)
  const archiveDirectory = join(temporaryDirectory, 'archive')
  await mkdir(archiveDirectory, { recursive: true })
  await run(
    [process.execPath, 'pm', 'pack', '--destination', archiveDirectory, '--ignore-scripts'],
    packageRoot
  )

  const archive = await findArchive(archiveDirectory)
  const consumer = await createConsumer(temporaryDirectory, archive)
  const environment = {
    ...process.env,
    BETTER_EFFECT_EXPECTED_ARTIFACT: 'fresh-packed'
  }

  await run(['node', 'hono-package-child.mjs'], consumer, environment)
  await run([process.execPath, 'hono-package-child.mjs'], consumer, environment)
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true })
}

console.log('Fresh packed Node/Bun Hono package smoke tests passed')
