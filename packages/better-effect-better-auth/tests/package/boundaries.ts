import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as ts from 'typescript'

const packageRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const repositoryRoot = resolve(packageRoot, '../..')
const sourceRoot = join(packageRoot, 'src')
const distRoot = join(packageRoot, 'dist')
const packageManifestPath = join(packageRoot, 'package.json')
const repositoryManifestPath = join(repositoryRoot, 'package.json')
const repositoryLockfilePath = join(repositoryRoot, 'bun.lock')

const expectedExports = {
  '.': './dist/index.mjs',
  './hooks': './dist/hooks.mjs',
  './package.json': './package.json'
} as const satisfies Record<string, string>

const expectedPeers = {
  'better-auth': '^1.7.0',
  'better-effect': '>=0.12.0 <0.14.0',
  'better-result': '^3.0.0',
  typescript: '>=5.7.0'
} as const satisfies Record<string, string>

const forbiddenPackagePrefixes = [
  'effect',
  '@effect',
  'hono',
  'next',
  '@hono',
  '@prisma',
  'prisma',
  'drizzle-orm',
  'drizzle-kit',
  'kysely',
  'mongodb',
  'pg',
  'postgres',
  'mysql',
  'mysql2',
  'better-sqlite3',
  'sqlite3',
  '@libsql',
  'react',
  'react-dom',
  'vue',
  'svelte',
  'solid-js'
] as const

const forbiddenPeerInternalPrefixes = ['better-auth/', 'better-effect/', 'better-result/'] as const
const allowedDevelopmentOnlyPackages = new Set(['hono'])

const allowedExternalImports = new Set([
  'better-auth/api',
  'better-effect',
  'better-result',
  'node:fs/promises',
  'node:os',
  'node:path',
  'node:url'
])

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

const isJsonString = (value: JsonValue | undefined): value is string =>
  value !== undefined && Object.prototype.toString.call(value) === '[object String]'

const readJsonRecord = async (path: string): Promise<JsonObject> => {
  const value: JsonValue = JSON.parse(await readFile(path, 'utf8'))

  assertCondition(isJsonObject(value), `Expected a JSON object in ${path}`)

  return value
}

const packageManifest = await readJsonRecord(packageManifestPath)
const repositoryManifest = await readJsonRecord(repositoryManifestPath)

const collectFiles = async (root: string): Promise<string[]> => {
  const files: string[] = []
  const pending = [root]

  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) {
      continue
    }

    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        pending.push(path)
      } else if (entry.isFile()) {
        files.push(path)
      }
    }
  }

  return files.sort()
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

  if (ts.isNonNullExpression(node)) {
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
  specifier === 'node:sqlite' ||
  forbiddenPackagePrefixes.some(
    (prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`)
  )

const isForbiddenPeerInternal = (specifier: string): boolean =>
  !allowedExternalImports.has(specifier) &&
  forbiddenPeerInternalPrefixes.some((prefix) => specifier.startsWith(prefix))

const isWithinPackageRoot = (path: string): boolean => {
  const relativePath = relative(packageRoot, path)
  return relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
}

const assertModuleBoundary = (path: string, source: string): void => {
  for (const specifier of moduleSpecifiers(source, path)) {
    assertCondition(!isForbiddenPackage(specifier), `Forbidden import ${specifier} in ${path}`)
    assertCondition(
      !isForbiddenPeerInternal(specifier),
      `Forbidden peer internal import ${specifier} in ${path}`
    )

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

const assertManifestExports = (manifest: JsonObject): void => {
  const exports = manifest['exports']

  assertCondition(isJsonObject(exports), 'Package exports must be an object')
  assertSameKeys(exports, expectedExports, 'Package exports')

  for (const [key, target] of Object.entries(expectedExports)) {
    assertCondition(exports[key] === target, `Unexpected export target for ${key}`)
  }
}

const assertManifestPeers = (manifest: JsonObject): void => {
  const peers = manifest['peerDependencies']

  assertCondition(isJsonObject(peers), 'Peer dependencies must be an object')
  assertSameKeys(peers, expectedPeers, 'Peer dependencies')

  for (const [name, range] of Object.entries(expectedPeers)) {
    assertCondition(peers[name] === range, `Unexpected peer range for ${name}`)
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
      const allowedDevelopmentOnly =
        section === 'devDependencies' && allowedDevelopmentOnlyPackages.has(name)
      assertCondition(
        allowedDevelopmentOnly || !isForbiddenPackage(name),
        `Forbidden dependency ${name} appears in ${section}`
      )
    }
  }

  assertCondition(!('dependencies' in manifest), 'The package must not have runtime dependencies')
  assertCondition(
    !('optionalDependencies' in manifest),
    'The package must not have optional runtime dependencies'
  )
}

const assertPackageManifest = (): void => {
  assertCondition(
    packageManifest['name'] === 'better-effect-better-auth',
    'Unexpected package name'
  )
  assertCondition(packageManifest['version'] === '0.1.0', 'Unexpected package version')
  assertCondition(packageManifest['type'] === 'module', 'The package must be ESM')
  assertCondition(
    packageManifest['sideEffects'] === false,
    'The package must declare no import side effects'
  )
  assertCondition(
    JSON.stringify(packageManifest['files']) ===
      JSON.stringify(['dist', 'LICENSE', 'README.md', 'CHANGELOG.md']),
    'Package files allowlist changed'
  )
  assertManifestExports(packageManifest)
  assertManifestPeers(packageManifest)
  assertNoForbiddenDependencyNames(packageManifest)

  const devDependencies = packageManifest['devDependencies']
  assertCondition(isJsonObject(devDependencies), 'Development dependencies must be an object')
  assertCondition(
    devDependencies['better-effect'] === 'workspace:*',
    'Workspace development dependency on better-effect is missing'
  )
  assertCondition(
    devDependencies['better-auth'] !== undefined,
    'Better Auth development dependency is missing'
  )
  assertCondition(
    devDependencies['better-result'] !== undefined,
    'better-result development dependency is missing'
  )

  const scripts = packageManifest['scripts']
  assertCondition(isJsonObject(scripts), 'Package scripts must be an object')
  const requiredScripts = [
    'build',
    'typecheck',
    'test:types',
    'test:types:minimum',
    'test',
    'test:package-boundaries',
    'test:package-consumer',
    'test:types:performance',
    'lint',
    'format:check',
    'publint',
    'check',
    'release:dry'
  ]

  for (const script of requiredScripts) {
    assertCondition(scripts[script] !== undefined, `Missing package script ${script}`)
  }
}

const assertRepositoryIntegration = async (): Promise<void> => {
  const workspaces = repositoryManifest['workspaces']
  assertCondition(
    Array.isArray(workspaces) && workspaces.includes('packages/*'),
    'Repository workspaces must include packages/*'
  )

  const scripts = repositoryManifest['scripts']
  assertCondition(isJsonObject(scripts), 'Repository scripts must be an object')
  const publintScript = scripts['publint']
  assertCondition(
    isJsonString(publintScript) && publintScript.includes('better-effect-better-auth'),
    'Root publint script must include better-effect-better-auth'
  )
  assertCondition(
    repositoryManifest['packageManager'] === 'bun@1.3.14',
    'Repository Bun version changed unexpectedly'
  )

  const lockfile = await readFile(repositoryLockfilePath, 'utf8')
  assertCondition(
    lockfile.includes('"packages/better-effect-better-auth"'),
    'bun.lock is missing the new workspace package'
  )
  assertCondition(
    lockfile.includes('"better-effect-better-auth@workspace:packages/better-effect-better-auth"'),
    'bun.lock is missing the new workspace resolution'
  )
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
  assertCondition(generatedNames.has('hooks.mjs'), 'Missing generated hooks.mjs')
  assertCondition(generatedNames.has('hooks.d.mts'), 'Missing generated hooks.d.mts')

  for (const path of [...sourceFiles, ...generatedModules]) {
    assertModuleBoundary(path, await readFile(path, 'utf8'))
  }

  const entrypoint = await import(pathToFileURL(join(distRoot, 'index.mjs')).href)
  const runtimeExports = Object.keys(entrypoint).sort()

  assertCondition(
    JSON.stringify(runtimeExports) ===
      JSON.stringify(['BetterAuth', 'BetterAuthApiError', 'Unauthenticated']),
    `Unexpected runtime exports: ${runtimeExports.join(', ')}`
  )

  const hooksEntrypoint = await import(pathToFileURL(join(distRoot, 'hooks.mjs')).href)
  const hooksRuntimeExports = Object.keys(hooksEntrypoint).sort()

  assertCondition(
    JSON.stringify(hooksRuntimeExports) === JSON.stringify(['BetterAuthHooks']),
    `Unexpected hooks runtime exports: ${hooksRuntimeExports.join(', ')}`
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

const assertSupportedModuleForms = (coreFixture: string, peerFixture: string): void => {
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
    peerFixture,
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
    'resolves outside the package root'
  )
  assertThrows(
    () =>
      assertModuleBoundary(
        coreFixture,
        "import Unsafe = require('../../better-effect/src/index.ts')"
      ),
    'resolves outside the package root'
  )
  assertThrows(
    () => assertModuleBoundary(coreFixture, "void __require('../../better-effect/src/index.ts')"),
    'resolves outside the package root'
  )
  assertThrows(
    () =>
      assertModuleBoundary(
        coreFixture,
        "void import('../../better-effect/src/index.ts', { with: { type: 'module' } })"
      ),
    'resolves outside the package root'
  )

  const outsidePath = join(packageRoot, '..', 'better-effect', 'src', 'index.ts')
  assertThrows(
    () => assertModuleBoundary(coreFixture, `void import(${JSON.stringify(outsidePath)})`),
    'resolves outside the package root'
  )
  assertThrows(
    () => assertModuleBoundary(coreFixture, "import '#outside-package'"),
    'Unapproved external import #outside-package'
  )
}

const assertExternalPolicy = (coreFixture: string): void => {
  assertThrows(
    () => assertModuleBoundary(coreFixture, "void import('better-auth/internal')"),
    'Forbidden peer internal import better-auth/internal'
  )
  assertThrows(
    () =>
      assertModuleBoundary(
        coreFixture,
        "void import(`better-effect/internal/runtime`, { with: { type: 'json' } })"
      ),
    'Forbidden peer internal import better-effect/internal/runtime'
  )
  assertThrows(
    () => assertModuleBoundary(coreFixture, "void import('better-result/internal')"),
    'Forbidden peer internal import better-result/internal'
  )
  assertThrows(
    () => assertModuleBoundary(coreFixture, "void import('better-effect/adapters/iti')"),
    'Forbidden peer internal import better-effect/adapters/iti'
  )
  assertThrows(
    () => assertModuleBoundary(coreFixture, "void import('better-effect/hono')"),
    'Forbidden peer internal import better-effect/hono'
  )
  assertThrows(
    () => assertModuleBoundary(coreFixture, "const driver = require('pg')"),
    'Forbidden import pg'
  )
  assertThrows(
    () => assertModuleBoundary(coreFixture, "void import('node:sqlite')"),
    'Forbidden import node:sqlite'
  )
  assertThrows(
    () => assertModuleBoundary(coreFixture, 'void import(dynamicSpecifier)'),
    'Unverifiable dynamic import'
  )
}

const assertBoundarySelfTests = (): void => {
  const coreFixture = join(sourceRoot, '__boundary_fixture__.ts')
  const peerFixture = join(sourceRoot, '__peer_boundary_fixture__.ts')

  assertSupportedModuleForms(coreFixture, peerFixture)
  assertIgnoresNonModuleText(coreFixture)
  assertBoundaryPathSafety(coreFixture)
  assertExternalPolicy(coreFixture)
}

const assertPackedManifest = async (): Promise<void> => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'better-effect-better-auth-boundaries-'))

  try {
    const packOutput = Bun.spawnSync({
      cmd: ['bun', 'pm', 'pack', '--destination', tempRoot, '--ignore-scripts'],
      cwd: packageRoot,
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const output = `${packOutput.stdout.toString()}\n${packOutput.stderr.toString()}`
    assertCondition(packOutput.exitCode === 0, `bun pm pack failed:\n${output}`)

    const archive = (await readdir(tempRoot)).find((entry) => entry.endsWith('.tgz'))
    assertCondition(archive !== undefined, 'bun pm pack did not create a tarball')

    const extractedRoot = join(tempRoot, 'extracted')
    await mkdir(extractedRoot, { recursive: true })
    const extraction = Bun.spawnSync({
      cmd: ['tar', '-xzf', join(tempRoot, archive), '-C', extractedRoot],
      stdout: 'pipe',
      stderr: 'pipe'
    })
    assertCondition(
      extraction.exitCode === 0,
      `tar extraction failed:\n${extraction.stderr.toString()}`
    )

    // SAFETY: this boundary test reads the manifest emitted by bun pm pack and checks the field below before use.
    const packedManifest = JSON.parse(
      await readFile(join(extractedRoot, 'package', 'package.json'), 'utf8')
    ) as {
      readonly peerDependencies: Readonly<Record<string, string>>
    }

    assertCondition(
      Object.values(packedManifest.peerDependencies).every(
        (version) => !version.startsWith('workspace:')
      ),
      'Packed package must not contain workspace peer versions'
    )
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

assertPackageManifest()
await assertRepositoryIntegration()
assertBoundarySelfTests()
await assertGeneratedPackage()
await assertPackedManifest()

console.log('better-effect-better-auth package boundary checks passed')
