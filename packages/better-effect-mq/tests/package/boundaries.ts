import { readdir, readFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as ts from 'typescript'

const packageRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
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

type Entrypoint = 'core' | 'testing'

const expectedCoreRuntimeExports = [
  'Codec',
  'InvalidJobTransitionError',
  'Job',
  'JobRegistry',
  'JobStore',
  'JobStoreWakeAbortedError',
  'JobCodecFailure',
  'JobDecodeFailure',
  'JobDefinitionError',
  'JobEncodeFailure',
  'JobId',
  'JobName',
  'JobNotCancellableError',
  'JobNotFoundError',
  'JobNotPromotableError',
  'JobNotRetryableError',
  'JobStoreFailure',
  'LeaseLostError',
  'LeaseToken',
  'Queue',
  'QueueName',
  'UnsupportedJobStoreOperationError',
  'WorkerId',
  'cancelJob',
  'claimJob',
  'compareJobOrder',
  'bindJob',
  'makeJobId',
  'makeJobName',
  'makeJobRecord',
  'makeJobRegistry',
  'makeLeaseToken',
  'makePersistedBackoff',
  'makePersistedJobFailure',
  'makeQueueName',
  'makeSerializedJobFailure',
  'makeWorkerId',
  'normalizeIdempotencyKey',
  'normalizeMetadata',
  'normalizeRetryable',
  'orderJobs',
  'promoteJob',
  'protocolVersion',
  'recoverStalledJob',
  'redriveJob',
  'reduceJob',
  'releaseJob',
  'requestJobCancellation',
  'runIdempotencyKey',
  'runMetadata',
  'runRetryable',
  'settleJob',
  'sortClaimCandidates',
  'transitionJob',
  'validateAttemptRecord',
  'validateDuration',
  'validateJobRecord',
  'validateOptionalDuration',
  'validateOptionalTimestamp',
  'validatePersistedBackoff',
  'validatePositiveDuration',
  'validateSerializedJobFailure',
  'validateTimestamp'
] as const

const allowedExternalImportsByEntrypoint = {
  core: new Set<string>(['better-effect', 'better-result']),
  testing: new Set<string>(['better-effect', 'better-result'])
} satisfies Record<Entrypoint, ReadonlySet<string>>

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

const forbiddenBetterEffectEntrypoints = [
  'better-effect/adapters',
  'better-effect/hono',
  'better-effect/runtime',
  'better-effect/standard-services',
  'better-effect/testing'
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

const isForbiddenDependencyName = (name: string): boolean =>
  name === 'effect' ||
  name === '@effect' ||
  name.startsWith('@effect/') ||
  forbiddenPackagePrefixes.some((prefix) => name === prefix || name.startsWith(`${prefix}/`))

const assertNoForbiddenDependencyNames = (manifest: JsonObject): void => {
  const sections = ['dependencies', 'optionalDependencies', 'devDependencies', 'peerDependencies']

  for (const section of sections) {
    const value = manifest[section]

    if (!isJsonObject(value)) {
      continue
    }

    for (const name of Object.keys(value)) {
      assertCondition(
        !isForbiddenDependencyName(name),
        `Forbidden dependency ${name} appears in ${section}`
      )
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

  if (ts.isTypeAssertionExpression(node)) {
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

  const addDeclarationSpecifier = (node: ts.Node | undefined, kind: string): void => {
    const specifier = staticModuleSpecifier(node)

    assertCondition(specifier !== undefined, `Unverifiable ${kind} in ${path}`)
    specifiers.add(specifier)
  }

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      addDeclarationSpecifier(node.moduleSpecifier, 'import declaration')
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      addDeclarationSpecifier(node.moduleSpecifier, 'export declaration')
    } else if (ts.isImportTypeNode(node)) {
      addDeclarationSpecifier(node.argument, 'import type')
    } else if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference

      if (ts.isExternalModuleReference(reference)) {
        addDeclarationSpecifier(reference.expression, 'import-equals declaration')
      }
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const callName = ts.isIdentifier(node.expression) ? node.expression.text : undefined

      if (isDynamicImport || callName === 'require' || callName === '__require') {
        const kind = isDynamicImport
          ? 'dynamic import'
          : `${callName === '__require' ? 'emitted helper' : 'static'} require`
        addDeclarationSpecifier(node.arguments[0], kind)
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)

  return [...specifiers]
}

const isForbiddenPackage = (specifier: string): boolean =>
  specifier === 'effect' ||
  specifier === '@effect' ||
  specifier === 'node:sqlite' ||
  specifier.startsWith('@effect/') ||
  forbiddenBetterEffectEntrypoints.some(
    (prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`)
  ) ||
  forbiddenPackagePrefixes.some(
    (prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`)
  )

const isWithinPackageRoot = (path: string): boolean => {
  const fromPackageRoot = relative(packageRoot, path)

  return (
    fromPackageRoot === '' ||
    (!isAbsolute(fromPackageRoot) &&
      fromPackageRoot !== '..' &&
      !fromPackageRoot.startsWith(`..${sep}`))
  )
}

const assertLocalSpecifier = (importingFile: string, specifier: string): void => {
  const resolvedPath = resolve(dirname(importingFile), specifier)
  const moduleLabel = relative(packageRoot, importingFile)

  assertCondition(
    isWithinPackageRoot(resolvedPath),
    `Local import ${specifier} in ${moduleLabel} resolves outside package root: ${resolvedPath}`
  )
}

const entrypointFor = (path: string): Entrypoint => {
  const packagePath = relative(packageRoot, path)
  const testingSourcePrefix = `src${sep}testing${sep}`
  const testingDistPrefix = `dist${sep}testing.`

  return packagePath.startsWith(testingSourcePrefix) || packagePath.startsWith(testingDistPrefix)
    ? 'testing'
    : 'core'
}

const assertModuleBoundary = (path: string, source: string): void => {
  for (const specifier of moduleSpecifiers(source, path)) {
    assertCondition(!isForbiddenPackage(specifier), `Forbidden import ${specifier} in ${path}`)

    if (specifier.startsWith('node:')) {
      continue
    }

    if (specifier.startsWith('#')) {
      throw new Error(
        `Package alias ${specifier} in ${relative(packageRoot, path)} cannot bypass the package-root audit`
      )
    }

    if (specifier.startsWith('.') || isAbsolute(specifier)) {
      assertLocalSpecifier(path, specifier)
      continue
    }

    const allowedImports = allowedExternalImportsByEntrypoint[entrypointFor(path)]

    assertCondition(
      allowedImports.has(specifier),
      `Unapproved external import ${specifier} in ${path}; only public package foundations are allowed`
    )
  }
}

const assertAllModuleBoundaries = async (paths: string[]): Promise<void> => {
  for (const path of paths) {
    const source = await readFile(path, 'utf8')
    assertModuleBoundary(path, source)
  }
}

const sourceModuleExtensions = ['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx']

const isSourceModule = (path: string): boolean =>
  sourceModuleExtensions.some((extension) => path.endsWith(extension))

const isGeneratedBundle = (path: string): boolean => path.endsWith('.mjs')

const isDeclaration = (path: string): boolean =>
  path.endsWith('.d.ts') || path.endsWith('.d.mts') || path.endsWith('.d.cts')

const assertRequiredFiles = (files: string[], required: string[], label: string): void => {
  const names = new Set(files.map((path) => relative(distRoot, path)))

  for (const name of required) {
    assertCondition(names.has(name), `Missing ${label} file ${name}`)
  }
}

const assertGeneratedBoundaries = async (): Promise<void> => {
  const sourceFiles = await collectFiles(sourceRoot)
  const generatedFiles = await collectFiles(distRoot)
  const sourceModules = sourceFiles.filter(isSourceModule)
  const bundles = generatedFiles.filter(isGeneratedBundle)
  const declarations = generatedFiles.filter(isDeclaration)

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

const assertThrows = (operation: () => void, expectedMessage: string): void => {
  let thrown = false
  let error: unknown

  try {
    operation()
  } catch (caught) {
    thrown = true
    error = caught
  }

  assertCondition(thrown, `Expected boundary audit to reject ${expectedMessage}`)
  assertCondition(error instanceof Error, `Boundary audit threw a non-Error for ${expectedMessage}`)
  assertCondition(
    error.message.includes(expectedMessage),
    `Expected boundary error containing ${expectedMessage}, got: ${error.message}`
  )
}

const assertSupportedModuleForms = (coreFixture: string, testingFixture: string): void => {
  const localImports = `
    import type { TypeOnly } from './type-only'
    type ImportedType = import('./import-type').TypeOnly
    export { value } from './exported'
    import './side-effect'
    import Alias = require('./alias')
    const required = require('./required')
    const helper = __require('./helper')
    void import('./dynamic', { with: { type: 'json' } })
    void import(
      \`./template\`,
      { with: { type: 'json' } }
    )
    void Alias
    void required
    void helper
    void (0 as unknown as TypeOnly)
  `
  const extracted = moduleSpecifiers(localImports, coreFixture).sort()
  const expected = [
    './alias',
    './dynamic',
    './exported',
    './helper',
    './import-type',
    './required',
    './side-effect',
    './template',
    './type-only'
  ]

  assertCondition(
    JSON.stringify(extracted) === JSON.stringify(expected),
    `AST module extraction missed a supported form: ${JSON.stringify(extracted)}`
  )
  assertModuleBoundary(coreFixture, localImports)
  assertModuleBoundary(
    testingFixture,
    "import { Effect } from 'better-effect'\nimport { Result } from 'better-result'"
  )
}

const assertIgnoresNonModuleText = (coreFixture: string): void => {
  assertModuleBoundary(coreFixture, `const source = "require('pg')"`)
  assertModuleBoundary(coreFixture, `/* import 'pg' */\nconst source = "import('pg')"`)
}

const assertBoundaryPathSafety = (coreFixture: string): void => {
  assertThrows(
    () => assertModuleBoundary(coreFixture, "import '../../better-effect/src/index'"),
    'outside package root'
  )
  assertThrows(
    () =>
      assertModuleBoundary(
        coreFixture,
        "import Unsafe = require('../../better-effect/src/index.ts')"
      ),
    'outside package root'
  )
  assertThrows(
    () => assertModuleBoundary(coreFixture, "void __require('../../better-effect/src/index.ts')"),
    'outside package root'
  )
  assertThrows(
    () =>
      assertModuleBoundary(
        coreFixture,
        "void import('../../better-effect/src/index.ts', { with: { type: 'module' } })"
      ),
    'outside package root'
  )

  const outsidePath = join(packageRoot, '..', 'better-effect', 'src', 'index.ts')
  assertThrows(
    () => assertModuleBoundary(coreFixture, `void import(${JSON.stringify(outsidePath)})`),
    'outside package root'
  )
  assertThrows(
    () => assertModuleBoundary(coreFixture, "import '#outside-package'"),
    'cannot bypass the package-root audit'
  )
}

const assertExternalPolicy = (coreFixture: string): void => {
  assertThrows(
    () => assertModuleBoundary(coreFixture, "void import('better-effect/adapters/iti')"),
    'Forbidden import'
  )
  assertThrows(
    () => assertModuleBoundary(coreFixture, "void import('better-effect/hono')"),
    'Forbidden import'
  )
  assertThrows(
    () => assertModuleBoundary(coreFixture, "const driver = require('pg')"),
    'Forbidden import'
  )
  assertThrows(
    () => assertModuleBoundary(coreFixture, "void import('node:sqlite')"),
    'Forbidden import'
  )
  assertThrows(
    () => assertModuleBoundary(coreFixture, 'void import(dynamicSpecifier)'),
    'Unverifiable dynamic import'
  )
}

const assertBoundarySelfTests = (): void => {
  const coreFixture = join(sourceRoot, 'boundary-fixture.ts')
  const testingFixture = join(sourceRoot, 'testing', 'boundary-fixture.ts')

  assertSupportedModuleForms(coreFixture, testingFixture)
  assertIgnoresNonModuleText(coreFixture)
  assertBoundaryPathSafety(coreFixture)
  assertExternalPolicy(coreFixture)
}

const assertCoreEntrypoint = async (path: string): Promise<void> => {
  const module = await import(pathToFileURL(path).href)
  const actual = Object.keys(module).sort()
  const expected = [...expectedCoreRuntimeExports].sort()

  assertCondition(
    JSON.stringify(actual) === JSON.stringify(expected),
    `Core entrypoint exports differ: expected ${expected.join(', ')}, got ${actual.join(', ')}`
  )
}

const assertTestingEntrypoint = async (path: string): Promise<void> => {
  const module = await import(pathToFileURL(path).href)
  const actual = Object.keys(module).sort()
  const expected = ['JobStoreConformanceError', 'jobStoreContract']

  assertCondition(
    JSON.stringify(actual) === JSON.stringify(expected),
    `Testing entrypoint exports differ: expected ${expected.join(', ')}, got ${actual.join(', ')}`
  )
}

assertBoundarySelfTests()
await assertManifest()
await assertGeneratedBoundaries()
await assertCoreEntrypoint(join(distRoot, 'index.mjs'))
await assertTestingEntrypoint(join(distRoot, 'testing.mjs'))

console.log('better-effect-mq package boundary checks passed')
