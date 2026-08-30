import { readdir, readFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import * as ts from 'typescript'

const packageRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const sourceRoot = join(packageRoot, 'src')
const distRoot = join(packageRoot, 'dist')

const expectedExports = {
  '.': './dist/index.mjs',
  './package.json': './package.json'
} as const satisfies Record<string, string>

const expectedPeers = {
  'better-auth': '^1.7.0',
  'better-effect': '^0.12.0',
  'better-result': '^3.0.0',
  typescript: '>=5.7.0'
} as const satisfies Record<string, string>

const allowedExternalImports = new Set([
  'better-auth',
  'better-auth/api',
  'better-effect',
  'better-result'
])

const forbiddenPackagePrefixes = [
  'effect',
  '@effect',
  'hono',
  'next',
  'react',
  'react-dom',
  'vue',
  'svelte',
  'solid-js',
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
  const manifest = await readJsonRecord(join(packageRoot, 'package.json'))
  const exports = manifest['exports']
  const peers = manifest['peerDependencies']

  assertCondition(manifest['name'] === 'better-effect-better-auth', 'Unexpected package name')
  assertCondition(manifest['version'] === '0.1.0', 'Unexpected package version')
  assertCondition(manifest['type'] === 'module', 'The package must be ESM')
  assertCondition(manifest['sideEffects'] === false, 'The package must be side-effect free')
  assertCondition(!('dependencies' in manifest), 'The package must not have runtime dependencies')
  assertCondition(
    !('optionalDependencies' in manifest),
    'The package must not have optional runtime dependencies'
  )
  assertCondition(isJsonObject(exports), 'Package exports must be an object')
  assertCondition(isJsonObject(peers), 'Peer dependencies must be an object')
  assertSameKeys(exports, expectedExports, 'Package exports')
  assertSameKeys(peers, expectedPeers, 'Peer dependencies')

  for (const [name, target] of Object.entries(expectedExports)) {
    assertCondition(exports[name] === target, `Unexpected export target for ${name}`)
  }

  for (const [name, range] of Object.entries(expectedPeers)) {
    assertCondition(peers[name] === range, `Unexpected peer range for ${name}`)
  }
}

const scriptKindFor = (path: string): ts.ScriptKind => {
  switch (extname(path)) {
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS
    case '.jsx':
      return ts.ScriptKind.JSX
    case '.tsx':
      return ts.ScriptKind.TSX
    default:
      return ts.ScriptKind.TS
  }
}

const staticModuleSpecifier = (node: ts.Node | undefined): string | undefined => {
  if (node === undefined) {
    return undefined
  }

  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text
  }

  if (ts.isLiteralTypeNode(node)) {
    return staticModuleSpecifier(node.literal)
  }

  if (ts.isParenthesizedExpression(node)) {
    return staticModuleSpecifier(node.expression)
  }

  if (ts.isAsExpression(node)) {
    return staticModuleSpecifier(node.expression)
  }

  if (ts.isSatisfiesExpression(node)) {
    return staticModuleSpecifier(node.expression)
  }

  return undefined
}

const moduleSpecifiers = (source: string, path: string): string[] => {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(path)
  )
  const specifiers = new Set<string>()

  const addSpecifier = (node: ts.Node | undefined, kind: string): void => {
    const specifier = staticModuleSpecifier(node)

    assertCondition(specifier !== undefined, `Unverifiable ${kind} in ${path}`)
    specifiers.add(specifier)
  }

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      addSpecifier(node.moduleSpecifier, 'import declaration')
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      addSpecifier(node.moduleSpecifier, 'export declaration')
    } else if (ts.isImportTypeNode(node)) {
      addSpecifier(node.argument, 'import type')
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      addSpecifier(node.arguments[0], 'dynamic import')
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)

  return [...specifiers]
}

const isForbiddenPackage = (specifier: string): boolean =>
  forbiddenPackagePrefixes.some(
    (prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`)
  ) ||
  (specifier.startsWith('better-auth/') && specifier !== 'better-auth/api') ||
  specifier.startsWith('better-effect/') ||
  specifier.startsWith('better-result/')

const isWithinPackageRoot = (path: string): boolean => {
  const fromPackageRoot = relative(packageRoot, path)

  return (
    fromPackageRoot === '' ||
    (!isAbsolute(fromPackageRoot) &&
      fromPackageRoot !== '..' &&
      !fromPackageRoot.startsWith(`..${sep}`))
  )
}

const assertModuleBoundary = (path: string, source: string): void => {
  for (const specifier of moduleSpecifiers(source, path)) {
    assertCondition(!isForbiddenPackage(specifier), `Forbidden import ${specifier} in ${path}`)

    if (specifier.startsWith('.') || isAbsolute(specifier)) {
      const resolvedPath = resolve(dirname(path), specifier)
      assertCondition(
        isWithinPackageRoot(resolvedPath),
        `Local import ${specifier} in ${path} resolves outside the package root`
      )
      continue
    }

    assertCondition(
      allowedExternalImports.has(specifier),
      `Unapproved external import ${specifier} in ${path}`
    )
  }
}

const isSourceModule = (path: string): boolean =>
  ['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx'].some((extension) =>
    path.endsWith(extension)
  )

const isGeneratedModule = (path: string): boolean =>
  path.endsWith('.mjs') || path.endsWith('.d.mts')

const assertGeneratedPackage = async (): Promise<void> => {
  const sourceFiles = (await collectFiles(sourceRoot)).filter(isSourceModule)
  const generatedFiles = await collectFiles(distRoot)
  const generatedModules = generatedFiles.filter(isGeneratedModule)
  const generatedNames = new Set(generatedFiles.map((path) => relative(distRoot, path)))

  assertCondition(sourceFiles.length > 0, 'Expected at least one source module')
  assertCondition(generatedNames.has('index.mjs'), 'Missing generated index.mjs')
  assertCondition(generatedNames.has('index.d.mts'), 'Missing generated index.d.mts')

  for (const path of [...sourceFiles, ...generatedModules]) {
    assertModuleBoundary(path, await readFile(path, 'utf8'))
  }

  const entrypoint = await import(pathToFileURL(join(distRoot, 'index.mjs')).href)
  const runtimeExports = Object.keys(entrypoint).sort()

  assertCondition(
    JSON.stringify(runtimeExports) === JSON.stringify(['BetterAuthApiError', 'Unauthenticated']),
    `Unexpected runtime exports: ${runtimeExports.join(', ')}`
  )
}

const assertThrows = (operation: () => void, expectedMessage: string): void => {
  let error: Error | undefined

  try {
    operation()
  } catch (cause) {
    if (cause instanceof Error) {
      error = cause
    }
  }

  assertCondition(error !== undefined, `Expected boundary audit to reject ${expectedMessage}`)
  assertCondition(
    error.message.includes(expectedMessage),
    `Expected boundary error containing ${expectedMessage}, got: ${error.message}`
  )
}

const assertBoundarySelfTests = (): void => {
  const fixture = join(sourceRoot, '__boundary_fixture__.ts')

  assertThrows(() => assertModuleBoundary(fixture, "import 'effect'"), 'Forbidden import effect')
  assertThrows(
    () => assertModuleBoundary(fixture, "import 'better-auth/internal'"),
    'Forbidden import better-auth/internal'
  )
  assertThrows(
    () => assertModuleBoundary(fixture, "import 'next/server'"),
    'Forbidden import next/server'
  )
  assertThrows(
    () => assertModuleBoundary(fixture, "import '../../outside'"),
    'resolves outside the package root'
  )
}

await assertManifest()
await assertGeneratedPackage()
assertBoundarySelfTests()

console.log('better-effect-better-auth package boundary checks passed')
