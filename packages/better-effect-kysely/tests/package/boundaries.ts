import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { scanModuleSpecifiers } from '../../../../scripts/scan-module-specifiers.ts'

const packageRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const repositoryRoot = resolve(packageRoot, '../..')
const sourceRoot = join(packageRoot, 'src')
const distRoot = join(packageRoot, 'dist')
const packageManifestPath = join(packageRoot, 'package.json')
const repositoryManifestPath = join(repositoryRoot, 'package.json')
const repositoryLockfilePath = join(repositoryRoot, 'bun.lock')
const releaseConfigPath = join(repositoryRoot, 'scripts/release-packages.json')

const expectedExports = {
  '.': './dist/index.mjs',
  './package.json': './package.json'
} as const

const expectedPeers = {
  'better-effect': '>=0.13.0 <0.14.0',
  'better-result': '^3.0.0',
  kysely: '>=0.29.5 <0.30.0',
  typescript: '>=6.0.0'
} as const

const allowedExternalImports = new Set(['better-effect', 'better-result', 'kysely'])
const developmentOnlyPackages = new Set([
  'better-sqlite3',
  'mysql2',
  'pg',
  'pglite',
  '@electric-sql/pglite',
  'sqlite3'
])
const forbiddenPackagePrefixes = [
  'effect',
  '@effect',
  'better-sqlite3',
  'mysql',
  'mysql2',
  'pg',
  'postgres',
  'pglite',
  '@electric-sql/pglite',
  'sqlite3',
  'drizzle-orm',
  'prisma',
  'typeorm',
  'sequelize'
] as const

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonValue[] | JsonObject
type JsonObject = { readonly [key: string]: JsonValue }

const assertCondition: (condition: boolean, message: string) => asserts condition = (
  condition,
  message
) => {
  if (!condition) throw new Error(message)
}

const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  value !== undefined && Object.prototype.toString.call(value) === '[object Object]'

const isJsonString = (value: JsonValue | undefined): value is string =>
  value !== undefined && Object.prototype.toString.call(value) === '[object String]'

const readJsonObject = async (path: string): Promise<JsonObject> => {
  const value: JsonValue = JSON.parse(await readFile(path, 'utf8'))
  assertCondition(isJsonObject(value), `Expected a JSON object in ${path}`)
  return value
}

const collectFiles = async (root: string): Promise<string[]> => {
  const files: string[] = []
  const pending = [root]

  while (pending.length > 0) {
    const directory = pending.pop()
    if (directory === undefined) continue

    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile()) files.push(path)
    }
  }

  return files.sort()
}

const moduleSpecifiers = (source: string, path: string): string[] =>
  scanModuleSpecifiers(source, path)

const isForbiddenPackage = (specifier: string): boolean =>
  forbiddenPackagePrefixes.some(
    (prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`)
  ) ||
  specifier === 'node:sqlite' ||
  specifier.startsWith('better-effect/') ||
  specifier.startsWith('better-result/') ||
  specifier.startsWith('kysely/src/') ||
  specifier.startsWith('kysely/dist/')

const isWithinPackage = (path: string): boolean => {
  const pathFromRoot = relative(packageRoot, path)
  return (
    pathFromRoot === '' ||
    (!isAbsolute(pathFromRoot) && pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`))
  )
}

const assertModuleBoundary = (path: string, source: string): void => {
  for (const specifier of moduleSpecifiers(source, path)) {
    assertCondition(!isForbiddenPackage(specifier), `Forbidden import ${specifier} in ${path}`)
    if (specifier.startsWith('#')) {
      throw new Error(`Package alias ${specifier} bypasses the package-root audit`)
    }
    if (specifier.startsWith('.') || isAbsolute(specifier)) {
      assertCondition(
        isWithinPackage(resolve(dirname(path), specifier)),
        `Local import ${specifier} escapes the package root`
      )
      continue
    }
    assertCondition(
      allowedExternalImports.has(specifier),
      `Unapproved external import ${specifier} in ${path}`
    )
  }
}

const assertNoUnsafePatterns = (path: string, source: string): void => {
  const unsafePatterns: readonly [RegExp, string][] = [
    [/\bProxy\b/, 'recursive Proxy'],
    [/\bdeclare\s+module\s+['"]kysely['"]/, 'Kysely module augmentation'],
    [/\b(?:Object\.)?(?:assign|defineProperty)\s*\([^\n)]*prototype/, 'prototype patch'],
    [/\.prototype\b/, 'prototype access']
  ]
  for (const [pattern, label] of unsafePatterns) {
    assertCondition(!pattern.test(source), `${label} found in ${path}`)
  }
}

const assertSameKeys = (
  actual: JsonObject,
  expected: Readonly<Record<string, string>>,
  label: string
): void => {
  const actualKeys = Object.keys(actual).sort()
  const expectedKeys = Object.keys(expected).sort()
  assertCondition(
    JSON.stringify(actualKeys) === JSON.stringify(expectedKeys),
    `${label} keys differ: expected ${expectedKeys.join(', ')}, got ${actualKeys.join(', ')}`
  )
}

const assertManifest = async (): Promise<void> => {
  const manifest = await readJsonObject(packageManifestPath)
  const coreManifest = await readJsonObject(
    join(repositoryRoot, 'packages/better-effect/package.json')
  )
  assertCondition(manifest['name'] === 'better-effect-kysely', 'Unexpected package name')
  assertCondition(manifest['version'] === '0.1.0', 'Unexpected package version')
  assertCondition(manifest['type'] === 'module', 'Package must be ESM')
  assertCondition(manifest['sideEffects'] === false, 'Package must be side-effect free')
  assertCondition(
    JSON.stringify(manifest['files']) ===
      JSON.stringify(['dist', 'LICENSE', 'README.md', 'CHANGELOG.md']),
    'Package files allowlist changed'
  )

  const exports = manifest['exports']
  assertCondition(isJsonObject(exports), 'Package exports must be an object')
  assertSameKeys(exports, expectedExports, 'Package exports')
  for (const [name, target] of Object.entries(expectedExports)) {
    assertCondition(exports[name] === target, `Unexpected export target for ${name}`)
  }

  const peers = manifest['peerDependencies']
  assertCondition(isJsonObject(peers), 'Peer dependencies must be an object')
  assertSameKeys(peers, expectedPeers, 'Peer dependencies')
  for (const [name, range] of Object.entries(expectedPeers)) {
    assertCondition(peers[name] === range, `Unexpected peer range for ${name}`)
  }

  assertCondition(!('dependencies' in manifest), 'Runtime dependencies are not allowed')
  assertCondition(
    !('optionalDependencies' in manifest),
    'Optional runtime dependencies are not allowed'
  )
  const sections = ['dependencies', 'optionalDependencies', 'devDependencies', 'peerDependencies']
  for (const section of sections) {
    const values = manifest[section]
    if (!isJsonObject(values)) continue
    for (const name of Object.keys(values)) {
      const allowedDevOnly = section === 'devDependencies' && developmentOnlyPackages.has(name)
      assertCondition(
        allowedDevOnly || !isForbiddenPackage(name),
        `Forbidden dependency ${name} appears in ${section}`
      )
    }
  }

  const devDependencies = manifest['devDependencies']
  assertCondition(isJsonObject(devDependencies), 'Development dependencies must be an object')
  assertCondition(
    devDependencies['better-effect'] === coreManifest['version'],
    'better-effect development pin is missing or stale'
  )
  assertCondition(
    devDependencies['kysely'] === '0.29.5',
    'Kysely development version is unexpected'
  )
}

const assertRepositoryIntegration = async (): Promise<void> => {
  const repositoryManifest = await readJsonObject(repositoryManifestPath)
  const workspaces = repositoryManifest['workspaces']
  assertCondition(
    Array.isArray(workspaces) && workspaces.includes('packages/*'),
    'Workspace is missing'
  )
  const scripts = repositoryManifest['scripts']
  assertCondition(isJsonObject(scripts), 'Repository scripts are missing')
  assertCondition(
    isJsonString(scripts['publint']) && scripts['publint'].includes('better-effect-kysely'),
    'Root publint script does not include better-effect-kysely'
  )

  const release = await readJsonObject(releaseConfigPath)
  const packages = release['packages']
  assertCondition(Array.isArray(packages), 'Release package configuration is missing')
  const entry = packages.find(
    (value): value is JsonObject => isJsonObject(value) && value['name'] === 'better-effect-kysely'
  )
  assertCondition(entry !== undefined, 'Release route for better-effect-kysely is missing')
  assertCondition(
    entry['directory'] === 'packages/better-effect-kysely',
    'Release directory is wrong'
  )
  assertCondition(
    entry['changelog'] === 'packages/better-effect-kysely/CHANGELOG.md',
    'Release changelog is wrong'
  )
  assertCondition(entry['tagPrefix'] === 'better-effect-kysely-v', 'Release tag prefix is wrong')
  assertCondition(entry['initialRelease'] === true, 'Release route must be an initial release')

  const lockfile = await readFile(repositoryLockfilePath, 'utf8')
  assertCondition(
    lockfile.includes('"packages/better-effect-kysely"'),
    'bun.lock misses the workspace'
  )
  assertCondition(
    lockfile.includes('"better-effect-kysely@workspace:packages/better-effect-kysely"'),
    'bun.lock misses the workspace resolution'
  )
}

const assertPublicDeclaration = async (): Promise<void> => {
  const declaration = await readFile(join(distRoot, 'index.d.mts'), 'utf8')
  const publicNames = [
    'KyselyEffect',
    'KyselyOperation',
    'KyselyExecutionOptions',
    'KyselyTransactionOptions',
    'KyselyQueryOperation',
    'KyselyService',
    'KyselyServiceFactory',
    'KyselyServiceInstance',
    'KyselyServiceTag',
    'KyselyServiceToken',
    'KyselyExecutable',
    'KyselyTakeFirstExecutable',
    'KyselyQueryError',
    'KyselyTransactionError'
  ]
  const exportStatement = declaration.slice(declaration.lastIndexOf('export {'))
  assertCondition(exportStatement.length > 0, 'Declaration has no export statement')
  for (const name of publicNames) {
    assertCondition(new RegExp(`\\b${name}\\b`).test(exportStatement), `Declaration misses ${name}`)
  }
  for (const forbidden of [
    'fromKyselyPromise',
    'query-options',
    'transaction-outcome',
    'better-effect-kysely/src/',
    'kysely/src/',
    'node_modules'
  ]) {
    assertCondition(!declaration.includes(forbidden), `Declaration exposes ${forbidden}`)
  }
  assertCondition(!/\bany\b/.test(exportStatement), 'Public export statement exposes any')
  const anyLines = declaration.split(/\r?\n/).filter((line) => /\bany\b/.test(line))
  assertCondition(
    anyLines.every(
      (line) =>
        line.includes('Execute any') ||
        line.includes('type AnyKysely') ||
        line.includes('type AnyTransactionProgram')
    ),
    'Declaration contains an unjustified any outside internal erased aliases'
  )
}

const assertGeneratedPackage = async (): Promise<void> => {
  const sourceFiles = await collectFiles(sourceRoot)
  const generatedFiles = await collectFiles(distRoot)
  const sourceModules = sourceFiles.filter((path) => /\.(?:ts|tsx|js|mjs|cjs)$/.test(path))
  const generatedModules = generatedFiles.filter((path) => /\.(?:d\.mts|mjs)$/.test(path))
  for (const name of ['index.mjs', 'index.d.mts']) {
    assertCondition(generatedFiles.includes(join(distRoot, name)), `Missing generated ${name}`)
  }
  assertCondition(sourceModules.length > 0, 'Expected a source module')
  for (const path of [...sourceModules, ...generatedModules]) {
    const source = await readFile(path, 'utf8')
    assertModuleBoundary(path, source)
    assertNoUnsafePatterns(path, source)
  }

  const entrypoint = await import(pathToFileURL(join(distRoot, 'index.mjs')).href)
  assertCondition(
    JSON.stringify(Object.keys(entrypoint).sort()) ===
      JSON.stringify(['KyselyEffect', 'KyselyQueryError', 'KyselyTransactionError']),
    'Published Kysely integration exports changed'
  )
}

const assertBoundarySelfTests = (): void => {
  const fixture = join(sourceRoot, '__boundary-fixture__.ts')
  const assertRejects = (source: string, expected: string): void => {
    let error: unknown
    try {
      assertModuleBoundary(fixture, source)
    } catch (cause) {
      error = cause
    }
    assertCondition(error instanceof Error, `Boundary accepted ${expected}`)
    assertCondition(error.message.includes(expected), `Boundary rejection changed for ${expected}`)
  }

  assertRejects("import 'effect'", 'Forbidden import effect')
  assertRejects("import '@effect/core'", 'Forbidden import @effect/core')
  assertRejects("import 'better-effect/internal'", 'Forbidden import better-effect/internal')
  assertRejects("import 'better-result/internal'", 'Forbidden import better-result/internal')
  assertRejects("import 'kysely/src/query-builder/select-query-builder'", 'Forbidden import')
  assertRejects("import 'pg'", 'Forbidden import pg')
  assertRejects("import '../../better-effect/src/index'", 'escapes the package root')
  assertRejects("import 'package-internal'", 'Unapproved external import package-internal')

  assertCondition(
    (() => {
      try {
        assertNoUnsafePatterns(fixture, 'const value = new Proxy({}, {})')
        return false
      } catch {
        return true
      }
    })(),
    'Boundary accepted a Proxy pattern'
  )
}

const assertSourceMaps = async (): Promise<void> => {
  for (const name of ['index.mjs.map', 'index.d.mts.map']) {
    if (!(await Bun.file(join(distRoot, name)).exists())) continue
    const map = await readJsonObject(join(distRoot, name))
    const sources = map['sources']
    assertCondition(Array.isArray(sources), `${name} must contain a sources array`)
    for (const source of sources) {
      assertCondition(isJsonString(source), `${name} contains a non-string source`)
      assertCondition(
        !isAbsolute(source) && !source.includes('node_modules') && !source.includes('/tmp/'),
        `${name} leaks a private build path: ${source}`
      )
    }
  }
}

const assertPackedArtifact = async (): Promise<void> => {
  const temporaryRoot = await mkdtemp(join(packageRoot, '.boundary-pack-'))
  try {
    const destination = join(temporaryRoot, 'archive')
    await mkdir(destination)
    const result = Bun.spawnSync({
      cmd: ['bun', 'pm', 'pack', '--destination', destination, '--ignore-scripts'],
      cwd: packageRoot,
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const output = `${result.stdout.toString()}\n${result.stderr.toString()}`
    assertCondition(result.exitCode === 0, `bun pm pack failed:\n${output}`)
    const archive = (await readdir(destination)).find((entry) => entry.endsWith('.tgz'))
    assertCondition(archive !== undefined, 'bun pm pack did not create an archive')
    const listed = Bun.spawnSync({
      cmd: ['tar', '-tzf', join(destination, archive)],
      cwd: packageRoot,
      stdout: 'pipe',
      stderr: 'pipe'
    })
    assertCondition(
      listed.exitCode === 0,
      `Unable to inspect archive:\n${listed.stderr.toString()}`
    )
    const entries = listed.stdout
      .toString()
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean)
    for (const required of [
      'package/package.json',
      'package/LICENSE',
      'package/README.md',
      'package/CHANGELOG.md',
      'package/dist/index.mjs',
      'package/dist/index.d.mts'
    ]) {
      assertCondition(entries.includes(required), `Archive is missing ${required}`)
    }
    assertCondition(
      !entries.some(
        (entry) => entry.startsWith('package/src/') || entry.startsWith('package/tests/')
      ),
      'Archive contains source or tests'
    )
    const packedManifest = Bun.spawnSync({
      cmd: ['tar', '-xOf', join(destination, archive), 'package/package.json'],
      cwd: packageRoot,
      stdout: 'pipe',
      stderr: 'pipe'
    })
    assertCondition(packedManifest.exitCode === 0, 'Unable to read packed manifest')
    assertCondition(
      !packedManifest.stdout.toString().match(/(?:workspace:|file:|link:)/),
      'Packed manifest contains a local dependency marker'
    )
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true })
  }
}

await assertManifest()
await assertRepositoryIntegration()
assertBoundarySelfTests()
await assertGeneratedPackage()
await assertPublicDeclaration()
await assertSourceMaps()
await assertPackedArtifact()

console.log('better-effect-kysely package boundary checks passed')
