import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const packageRoot = resolve(import.meta.dir, '../..')
const repositoryRoot = resolve(packageRoot, '../..')
const sourceRoot = join(packageRoot, 'src')
const distRoot = join(packageRoot, 'dist')
const packageManifestPath = join(packageRoot, 'package.json')
const repositoryManifestPath = join(repositoryRoot, 'package.json')
const repositoryLockfilePath = join(repositoryRoot, 'bun.lock')

const forbiddenPackagePrefixes = [
  'effect',
  '@effect/',
  'hono',
  'next',
  '@hono/',
  '@prisma/',
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
  '@libsql/',
  'react',
  'react-dom',
  'vue',
  'svelte',
  'solid-js'
] as const

const forbiddenPeerInternals = [
  /^better-auth\/.+\/.+/,
  /^better-effect\/.+\/.+/,
  /^better-result\/.+\/.+/
] as const

const allowedExternalImports = new Set([
  'better-auth/api',
  'better-effect',
  'better-result',
  'node:fs/promises',
  'node:os',
  'node:path',
  'node:url'
])

const packageManifest = JSON.parse(await readFile(packageManifestPath, 'utf8')) as {
  readonly name: string
  readonly version: string
  readonly type: string
  readonly sideEffects: boolean
  readonly files: readonly string[]
  readonly exports: Readonly<Record<string, string>>
  readonly scripts: Readonly<Record<string, string>>
  readonly peerDependencies: Readonly<Record<string, string>>
  readonly devDependencies: Readonly<Record<string, string>>
}

const repositoryManifest = JSON.parse(await readFile(repositoryManifestPath, 'utf8')) as {
  readonly workspaces: readonly string[]
  readonly scripts: Readonly<Record<string, string>>
  readonly packageManager: string
}

const assertCondition: (condition: boolean, message: string) => asserts condition = (
  condition,
  message
) => {
  if (!condition) {
    throw new Error(message)
  }
}

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

const collectImportSpecifiers = (source: string): string[] => {
  const specifiers: string[] = []
  const patterns = [
    /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ]

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier !== undefined) {
        specifiers.push(specifier)
      }
    }
  }

  return specifiers
}

const isForbiddenPackage = (specifier: string): boolean =>
  forbiddenPackagePrefixes.some(
    (prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`)
  )

const isForbiddenPeerInternal = (specifier: string): boolean =>
  forbiddenPeerInternals.some((pattern) => pattern.test(specifier))

const isWithinPackageRoot = (path: string): boolean => {
  const relativePath = relative(packageRoot, path)
  return relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
}

const assertModuleBoundary = (path: string, source: string): void => {
  for (const specifier of collectImportSpecifiers(source)) {
    assertCondition(!isForbiddenPackage(specifier), `Forbidden import ${specifier} in ${path}`)
    assertCondition(
      !isForbiddenPeerInternal(specifier),
      `Forbidden peer internal import ${specifier} in ${path}`
    )

    if (specifier.startsWith('.')) {
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

const assertPackageManifest = (): void => {
  assertCondition(packageManifest.name === 'better-effect-better-auth', 'Unexpected package name')
  assertCondition(packageManifest.version === '0.1.0', 'Unexpected initial package version')
  assertCondition(packageManifest.type === 'module', 'Package must be ESM-only')
  assertCondition(packageManifest.sideEffects === false, 'Package must declare sideEffects false')
  assertCondition(
    JSON.stringify(packageManifest.files) === JSON.stringify(['dist', 'LICENSE', 'README.md']),
    'Package files allowlist changed'
  )
  assertCondition(
    packageManifest.exports['.'] === './dist/index.mjs',
    'Root export must resolve to the ESM artifact'
  )
  assertCondition(
    packageManifest.exports['./package.json'] === './package.json',
    'Package manifest export is missing'
  )

  const expectedPeers = {
    'better-auth': '^1.7.0',
    'better-effect': '^0.12.0',
    'better-result': '^3.0.0',
    typescript: '>=5.7.0'
  }
  assertCondition(
    JSON.stringify(packageManifest.peerDependencies) === JSON.stringify(expectedPeers),
    'Peer dependency contract changed'
  )
  assertCondition(
    packageManifest.devDependencies['better-effect'] === 'workspace:*',
    'Workspace development dependency on better-effect is missing'
  )
  assertCondition(
    packageManifest.devDependencies['better-auth'] !== undefined,
    'Better Auth development dependency is missing'
  )
  assertCondition(
    packageManifest.devDependencies['better-result'] !== undefined,
    'better-result development dependency is missing'
  )

  const requiredScripts = [
    'build',
    'typecheck',
    'test:types',
    'test:types:minimum',
    'test',
    'test:package-boundaries',
    'test:package-consumer',
    'lint',
    'format:check',
    'publint',
    'check',
    'release:dry'
  ]

  for (const script of requiredScripts) {
    assertCondition(
      packageManifest.scripts[script] !== undefined,
      `Missing package script ${script}`
    )
  }
}

const assertRepositoryIntegration = async (): Promise<void> => {
  assertCondition(
    repositoryManifest.workspaces.includes('packages/*'),
    'Repository workspaces must include packages/*'
  )
  assertCondition(
    repositoryManifest.scripts.publint?.includes('better-effect-better-auth') === true,
    'Root publint script must include better-effect-better-auth'
  )
  assertCondition(
    repositoryManifest.packageManager === 'bun@1.3.14',
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
    () => assertModuleBoundary(fixture, "import 'better-effect/internal/runtime'"),
    'Forbidden peer internal import better-effect/internal/runtime'
  )
  assertThrows(
    () => assertModuleBoundary(fixture, "import 'better-result/internal'"),
    'Forbidden peer internal import better-result/internal'
  )
  assertThrows(() => assertModuleBoundary(fixture, "import 'hono'"), 'Forbidden import hono')
  assertThrows(
    () => assertModuleBoundary(fixture, "import 'drizzle-orm'"),
    'Forbidden import drizzle-orm'
  )
  assertThrows(() => assertModuleBoundary(fixture, "import 'react'"), 'Forbidden import react')
  assertThrows(
    () => assertModuleBoundary(fixture, "import '../../outside'"),
    'resolves outside the package root'
  )
  assertThrows(
    () => assertModuleBoundary(fixture, "import 'unapproved-package'"),
    'Unapproved external import unapproved-package'
  )
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

    const packedManifest = JSON.parse(
      await readFile(join(extractedRoot, 'package', 'package.json'), 'utf8')
    ) as {
      readonly devDependencies?: Readonly<Record<string, string>>
      readonly peerDependencies: Readonly<Record<string, string>>
    }

    assertCondition(
      packedManifest.devDependencies === undefined,
      'Packed package must not publish devDependencies'
    )
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
