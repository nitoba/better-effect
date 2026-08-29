import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = fileURLToPath(new URL('../..', import.meta.url))
const sourceRoot = join(packageRoot, 'src')
const distRoot = join(packageRoot, 'dist')
const expectedExports = {
  '.': './dist/index.mjs',
  './testing': './dist/testing.mjs',
  './package.json': './package.json'
} as const satisfies Record<string, string>

const expectedPeers = {
  'better-effect': '^0.11.0',
  'better-result': '^3.0.0',
  typescript: '>=5.7.0'
} as const satisfies Record<string, string>

const allowedExternalImports = new Set([
  'better-effect',
  'better-effect/adapters/iti',
  'better-effect/hono',
  'better-effect/runtime/explicit',
  'better-effect/runtime/node',
  'better-effect/standard-services',
  'better-effect/testing',
  'better-result'
])

const forbiddenPackagePrefixes = [
  'drizzle-orm',
  '@drizzle',
  'redis',
  'ioredis',
  '@redis',
  'mongodb',
  'mongoose',
  'mysql',
  'mysql2',
  'pg',
  'postgres',
  'postgres.js',
  'sequelize',
  'typeorm',
  'kysely',
  'knex',
  'prisma',
  '@prisma',
  'sqlite3',
  'better-sqlite3',
  '@libsql',
  '@planetscale'
]

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonValue[] | JsonObject
type JsonObject = { readonly [key: string]: JsonValue }

const assertCondition: (condition: boolean, message: string) => asserts condition = (
  condition,
  message
) => {
  if (!condition) {
    throw new Error(message)
  }
}

const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  value !== undefined && Object.prototype.toString.call(value) === '[object Object]'

const readJsonRecord = async (path: string): Promise<JsonObject> => {
  const value: JsonValue = JSON.parse(await readFile(path, 'utf8'))

  assertCondition(isJsonObject(value), `Expected a JSON object in ${path}`)

  return value
}

const collectFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const path = join(directory, entry.name)

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path)))
    } else {
      files.push(path)
    }
  }

  return files
}

const assertSameKeys = (
  actual: JsonObject,
  expected: Record<string, string>,
  label: string
): void => {
  const actualKeys = Object.keys(actual).sort()
  const expectedKeys = Object.keys(expected).sort()

  assertCondition(
    JSON.stringify(actualKeys) === JSON.stringify(expectedKeys),
    `${label} keys differ: expected ${expectedKeys.join(', ')}, got ${actualKeys.join(', ')}`
  )
}

const assertManifestExports = (manifest: JsonObject): void => {
  const exports = manifest['exports']

  assertCondition(isJsonObject(exports), 'Package exports must be an object')
  assertSameKeys(exports, expectedExports, 'Package exports')

  for (const [key, expected] of Object.entries(expectedExports)) {
    assertCondition(exports[key] === expected, `Unexpected export target for ${key}`)
  }
}

const assertManifestPeers = (manifest: JsonObject): void => {
  const peers = manifest['peerDependencies']

  assertCondition(isJsonObject(peers), 'Peer dependencies must be an object')
  assertSameKeys(peers, expectedPeers, 'Peer dependencies')

  for (const [name, expected] of Object.entries(expectedPeers)) {
    assertCondition(peers[name] === expected, `Unexpected peer range for ${name}`)
  }
}

const assertNoForbiddenDependencyNames = (manifest: JsonObject): void => {
  const sections = ['dependencies', 'optionalDependencies', 'devDependencies', 'peerDependencies']

  for (const section of sections) {
    const value = manifest[section]

    if (!isJsonObject(value)) {
      continue
    }

    for (const name of Object.keys(value)) {
      const forbidden =
        name === 'effect' ||
        name === '@effect' ||
        name.startsWith('@effect/') ||
        forbiddenPackagePrefixes.some((prefix) => name === prefix || name.startsWith(`${prefix}/`))

      assertCondition(!forbidden, `Forbidden dependency ${name} appears in ${section}`)
    }
  }

  assertCondition(
    !('dependencies' in manifest),
    'The core package must not have runtime dependencies'
  )
  assertCondition(
    !('optionalDependencies' in manifest),
    'The core package must not have optional runtime dependencies'
  )
}

const assertManifest = async (): Promise<void> => {
  const manifest = await readJsonRecord(join(packageRoot, 'package.json'))

  assertCondition(manifest['name'] === 'better-effect-mq', 'Unexpected package name')
  assertCondition(manifest['version'] === '0.1.0', 'Unexpected package version')
  assertCondition(manifest['type'] === 'module', 'The package must be ESM')
  assertCondition(
    manifest['sideEffects'] === false,
    'The package must declare no import side effects'
  )
  assertManifestExports(manifest)
  assertManifestPeers(manifest)
  assertNoForbiddenDependencyNames(manifest)
}

const moduleSpecifiers = (source: string): string[] => {
  const specifiers = new Set<string>()
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?[\s\S]*?\sfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g
  ]

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]

      if (specifier !== undefined) {
        specifiers.add(specifier)
      }
    }
  }

  return [...specifiers]
}

const isLocalSpecifier = (specifier: string): boolean =>
  specifier.startsWith('.') ||
  specifier.startsWith('/') ||
  specifier.startsWith('#') ||
  specifier.startsWith('node:')

const isForbiddenPackage = (specifier: string): boolean =>
  specifier === 'effect' ||
  specifier === '@effect' ||
  specifier === 'node:sqlite' ||
  specifier.startsWith('@effect/') ||
  forbiddenPackagePrefixes.some(
    (prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`)
  )

const assertModuleBoundary = (path: string, source: string): void => {
  for (const specifier of moduleSpecifiers(source)) {
    assertCondition(!isForbiddenPackage(specifier), `Forbidden import ${specifier} in ${path}`)

    if (isLocalSpecifier(specifier)) {
      continue
    }

    assertCondition(
      allowedExternalImports.has(specifier),
      `Unapproved external import ${specifier} in ${path}; adapters must stay out of core`
    )
  }
}

const assertAllModuleBoundaries = async (paths: string[]): Promise<void> => {
  for (const path of paths) {
    const source = await readFile(path, 'utf8')
    assertModuleBoundary(relative(packageRoot, path), source)
  }
}

const assertRequiredFiles = (files: string[], required: string[], label: string): void => {
  const names = new Set(files.map((path) => relative(distRoot, path)))

  for (const name of required) {
    assertCondition(names.has(name), `Missing ${label} file ${name}`)
  }
}

const assertGeneratedBoundaries = async (): Promise<void> => {
  const sourceFiles = await collectFiles(sourceRoot)
  const generatedFiles = await collectFiles(distRoot)
  const sourceModules = sourceFiles.filter((path) => /\.(?:[cm]?ts|tsx)$/.test(path))
  const bundles = generatedFiles.filter((path) => path.endsWith('.mjs'))
  const declarations = generatedFiles.filter((path) => path.endsWith('.d.mts'))

  assertCondition(sourceModules.length >= 2, 'Expected both source entrypoints to exist')
  assertCondition(bundles.length >= 2, 'Expected both ESM entrypoints to be emitted')
  assertCondition(declarations.length >= 2, 'Expected declarations for both ESM entrypoints')
  assertRequiredFiles(
    generatedFiles,
    ['index.mjs', 'index.d.mts', 'testing.mjs', 'testing.d.mts'],
    'generated'
  )
  await assertAllModuleBoundaries([...sourceModules, ...bundles, ...declarations])
}

const assertInertEntrypoint = async (path: string, label: string): Promise<void> => {
  const module = await import(pathToFileURL(path).href)

  assertCondition(Object.keys(module).length === 0, `${label} exposes provisional runtime APIs`)
}

await assertManifest()
await assertGeneratedBoundaries()
await assertInertEntrypoint(join(distRoot, 'index.mjs'), 'Core entrypoint')
await assertInertEntrypoint(join(distRoot, 'testing.mjs'), 'Testing entrypoint')

console.log('better-effect-mq package boundary checks passed')
