import { mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const repositoryRoot = resolve(packageRoot, '../..')
const fixtureRoot = join(packageRoot, 'tests/package/consumer')
const temporaryRoot = await mkdtemp(join('/tmp', 'better-effect-mq-mysql-consumer-'))
const archiveRoot = join(temporaryRoot, 'archives')
const nodeModules = join(fixtureRoot, 'node_modules')
const fixtureLock = join(fixtureRoot, 'bun.lock')

const run = (command: readonly string[], cwd: string): void => {
  const result = Bun.spawnSync({ cmd: [...command], cwd, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(' ')} failed:\n${result.stdout.toString()}\n${result.stderr.toString()}`
    )
  }
}

const pack = async (name: string, root: string): Promise<string> => {
  const destination = join(archiveRoot, name)
  await mkdir(destination, { recursive: true })
  await Bun.write(join(destination, '.keep'), '')
  run(['bun', 'pm', 'pack', '--ignore-scripts', '--destination', destination], root)
  const archives = (await readdir(destination)).filter((entry) => entry.endsWith('.tgz'))
  if (archives.length !== 1) throw new Error(`Expected one ${name} archive`)
  return join(destination, archives[0]!)
}

const installArchive = async (archive: string, name: string): Promise<void> => {
  run(['tar', '-xzf', archive, '-C', nodeModules], repositoryRoot)
  await rename(join(nodeModules, 'package'), join(nodeModules, name))
}

try {
  await rm(nodeModules, { recursive: true, force: true })
  await rm(fixtureLock, { force: true })
  run(['bun', 'install', '--ignore-scripts'], fixtureRoot)
  await Bun.write(join(temporaryRoot, '.keep'), '')
  await mkdir(archiveRoot, { recursive: true })

  const coreArchive = await pack('core', join(repositoryRoot, 'packages/better-effect'))
  const mysqlArchive = await pack('mysql', packageRoot)
  await Bun.write(join(nodeModules, '.keep'), '')
  await installArchive(coreArchive, 'better-effect')
  await installArchive(mysqlArchive, 'better-effect-mq-mysql')

  run(
    [
      'bun',
      'run',
      '--silent',
      'tsc',
      '--',
      '-p',
      join(fixtureRoot, 'tsconfig.json'),
      '--pretty',
      'false'
    ],
    packageRoot
  )
  run(['node', 'smoke.mjs'], fixtureRoot)
  run(['bun', 'smoke.mjs'], fixtureRoot)
  console.log('external MySQL package consumer passed')
} finally {
  await rm(nodeModules, { recursive: true, force: true })
  await rm(fixtureLock, { force: true })
  await rm(temporaryRoot, { recursive: true, force: true })
}
