import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))
const fixtureRoot = join(packageRoot, 'tests/fixtures/next-app')
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'better-effect-next-package-'))

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

// SAFETY: package.json is the repository-controlled manifest read at this package boundary.
const packageManifest = JSON.parse(await Bun.file(join(packageRoot, 'package.json')).text()) as {
  readonly version?: string
  readonly exports?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly peerDependenciesMeta?: Record<string, { readonly optional?: boolean }>
}

assertCondition(packageManifest.exports?.['./next'] === './dist/next.mjs', 'Missing ./next export')
assertCondition(
  packageManifest.peerDependencies?.next === '>=15.5.0 <17.0.0',
  'Next peer range must support Next 15 and 16'
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

const fixtureTsconfig = join(fixtureRoot, 'tsconfig.json')
const originalFixtureTsconfig = await readFile(fixtureTsconfig, 'utf8')
const fixtureNextEnv = join(fixtureRoot, 'next-env.d.ts')
const originalFixtureNextEnv = await readFile(fixtureNextEnv, 'utf8')
const fixtureNodeModules = join(fixtureRoot, 'node_modules')

const linkDependency = async (name: string): Promise<void> => {
  const source = name === 'better-effect' ? packageRoot : resolve(packageRoot, 'node_modules', name)
  const target = join(fixtureNodeModules, name)
  await mkdir(join(target, '..'), { recursive: true })
  await symlink(source, target, 'junction')
}

try {
  await mkdir(join(fixtureNodeModules, '@types'), { recursive: true })
  for (const dependency of [
    'better-effect',
    'better-result',
    'next',
    'react',
    'react-dom',
    'typescript',
    '@types/node',
    '@types/react'
  ]) {
    await linkDependency(dependency)
  }

  await run([process.execPath, 'run', 'test:package-next'])
  await run([process.execPath, 'run', 'test:package-next:minimum'])

  await run([process.execPath, 'x', 'next', 'typegen'], fixtureRoot)
  await run([process.execPath, 'x', 'tsc', '--noEmit', '--pretty', 'false'], fixtureRoot)
  await run([process.execPath, 'x', 'next', 'build'], fixtureRoot)

  const archiveDirectory = join(temporaryDirectory, 'archive')
  await mkdir(archiveDirectory, { recursive: true })
  await run([process.execPath, 'pm', 'pack', '--destination', archiveDirectory, '--ignore-scripts'])
  const archive = join(archiveDirectory, `better-effect-${packageManifest.version}.tgz`)
  const consumer = join(temporaryDirectory, 'consumer')
  const consumerNodeModules = join(consumer, 'node_modules')
  await mkdir(consumerNodeModules, { recursive: true })
  await run(['tar', '-xzf', archive, '-C', consumerNodeModules])
  await Bun.write(
    join(consumer, 'package.json'),
    JSON.stringify({
      name: 'better-effect-next-consumer',
      private: true,
      type: 'module',
      dependencies: { next: '16.3.0' }
    })
  )
  await symlink(
    join(consumerNodeModules, 'package'),
    join(consumerNodeModules, 'better-effect'),
    'junction'
  )
  await cp(
    resolve(packageRoot, 'node_modules/better-result'),
    join(consumerNodeModules, 'better-result'),
    {
      dereference: true,
      recursive: true
    }
  )
  await cp(resolve(packageRoot, 'node_modules/next'), join(consumerNodeModules, 'next'), {
    dereference: true,
    recursive: true
  })
  await cp(
    join(packageRoot, 'tests/helpers/next-package-child.mjs'),
    join(consumer, 'next-package-child.mjs')
  )
  assertCondition(
    await Bun.file(join(consumerNodeModules, 'next/package.json')).exists(),
    'Packed consumer did not install the optional Next peer'
  )
  await run(['node', 'next-package-child.mjs'], consumer)
  await run([process.execPath, 'next-package-child.mjs'], consumer)
} finally {
  await writeFile(fixtureTsconfig, originalFixtureTsconfig)
  await writeFile(fixtureNextEnv, originalFixtureNextEnv)
  await rm(fixtureNodeModules, { force: true, recursive: true })
  await rm(join(fixtureRoot, '.next'), { force: true, recursive: true })
  await rm(temporaryDirectory, { force: true, recursive: true })
}

console.log('Fresh packed NextEffect package and App Router fixture checks passed')
