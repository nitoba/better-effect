import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { scanModuleSpecifiers } from '../../../../scripts/scan-module-specifiers.ts'

const packageRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const repositoryRoot = resolve(packageRoot, '../..')
const sourceRoot = join(packageRoot, 'src')
const distRoot = join(packageRoot, 'dist')
const repositoryLockfilePath = join(repositoryRoot, 'bun.lock')
const coreSourceRoot = join(repositoryRoot, 'packages/better-effect/src')

const expectedExports = {
  '.': './dist/index.mjs',
  './package.json': './package.json'
} as const

const expectedPeers = {
  'better-effect': '>=0.13.0 <0.14.0',
  'better-effect-schema': '>=0.1.0 <0.2.0',
  'better-result': '^3.0.0',
  typescript: '>=6.0.0'
} as const

const allowedExternalImports = new Set([
  'ofetch',
  'better-effect',
  'better-effect-schema',
  'better-result'
])
const forbiddenPackagePrefixes = ['effect', '@effect', 'better-effect/', 'better-result/']

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

const assertSameKeys = (
  actual: JsonObject,
  expected: Readonly<Record<string, string>>,
  label: string
): void => {
  assertCondition(
    JSON.stringify(Object.keys(actual).sort()) === JSON.stringify(Object.keys(expected).sort()),
    `${label} keys differ`
  )
}

const assertModuleBoundary = (path: string, source: string): void => {
  for (const specifier of scanModuleSpecifiers(source, path)) {
    assertCondition(
      !forbiddenPackagePrefixes.some(
        (prefix) => specifier === prefix || specifier.startsWith(prefix)
      ),
      `Forbidden import ${specifier} in ${path}`
    )

    if (specifier.startsWith('#')) {
      throw new Error(`Package alias ${specifier} bypasses the package-root audit`)
    }

    if (specifier.startsWith('.') || isAbsolute(specifier)) {
      const pathFromRoot = relative(packageRoot, resolve(dirname(path), specifier))
      assertCondition(
        pathFromRoot === '' || (!isAbsolute(pathFromRoot) && !pathFromRoot.startsWith(`..${sep}`)),
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

const assertManifest = async (): Promise<void> => {
  const manifest = await readJsonObject(join(packageRoot, 'package.json'))
  assertCondition(manifest['name'] === 'better-effect-http', 'Unexpected package name')
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

  const dependencies = manifest['dependencies']
  assertCondition(isJsonObject(dependencies), 'Runtime dependencies are missing')
  assertCondition(dependencies['ofetch'] === '^1.5.1', 'ofetch must remain on stable v1')
  assertCondition(!('effect' in dependencies), 'Effect TS must not be a dependency')
}

const assertRepositoryIntegration = async (): Promise<void> => {
  const repositoryManifest = await readJsonObject(join(repositoryRoot, 'package.json'))
  const scripts = repositoryManifest['scripts']
  assertCondition(isJsonObject(scripts), 'Repository scripts are missing')
  assertCondition(
    isJsonString(scripts['publint']) && scripts['publint'].includes('better-effect-http'),
    'Root publint script does not include better-effect-http'
  )

  const lockfile = await readFile(repositoryLockfilePath, 'utf8')
  assertCondition(
    lockfile.includes('"packages/better-effect-http"') &&
      lockfile.includes('"better-effect-http@workspace:packages/better-effect-http"'),
    'bun.lock misses the better-effect-http workspace'
  )

  const release = await readJsonObject(join(repositoryRoot, 'scripts/release-packages.json'))
  const packages = release['packages']
  assertCondition(Array.isArray(packages), 'Release package configuration is missing')
  const entry = packages.find(
    (value): value is JsonObject => isJsonObject(value) && value['name'] === 'better-effect-http'
  )
  assertCondition(entry !== undefined, 'Release route for better-effect-http is missing')
  assertCondition(
    entry['directory'] === 'packages/better-effect-http',
    'Release directory is wrong'
  )
  assertCondition(
    entry['changelog'] === 'packages/better-effect-http/CHANGELOG.md',
    'Release changelog is wrong'
  )
  assertCondition(entry['tagPrefix'] === 'better-effect-http-v', 'Release tag prefix is wrong')
  assertCondition(entry['initialRelease'] === true, 'Release route must be an initial release')
}

const assertCoreIsolation = async (): Promise<void> => {
  for (const path of await collectFiles(coreSourceRoot)) {
    const source = await readFile(path, 'utf8')
    assertCondition(
      !/from ['"](?:ofetch|better-effect-http)(?:['"]|\/)/u.test(source),
      `HTTP transport leaked into better-effect core: ${path}`
    )
  }
}

const assertGeneratedPackage = async (): Promise<void> => {
  for (const name of ['index.mjs', 'index.d.mts']) {
    assertCondition(
      (await collectFiles(distRoot)).includes(join(distRoot, name)),
      `Missing generated ${name}`
    )
  }

  const sourceFiles = await collectFiles(sourceRoot)
  for (const path of sourceFiles) {
    assertModuleBoundary(path, await readFile(path, 'utf8'))
  }

  const generatedFiles = await collectFiles(distRoot)
  for (const path of generatedFiles.filter((file) => /\.(?:d\.mts|mjs)$/u.test(file))) {
    assertModuleBoundary(path, await readFile(path, 'utf8'))
  }

  const entrypoint = await import(pathToFileURL(join(distRoot, 'index.mjs')).href)
  for (const exportName of ['HttpRequest', 'HttpRequestError', 'validateHttpOptions']) {
    assertCondition(
      exportName in entrypoint,
      `Missing public HTTP foundation export: ${exportName}`
    )
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
    assertCondition(result.exitCode === 0, `bun pm pack failed:\n${result.stderr.toString()}`)
    const archive = (await readdir(destination)).find((entry) => entry.endsWith('.tgz'))
    assertCondition(archive !== undefined, 'bun pm pack did not create an archive')
    const listed = Bun.spawnSync({
      cmd: ['tar', '-tzf', join(destination, archive)],
      cwd: packageRoot,
      stdout: 'pipe',
      stderr: 'pipe'
    })
    assertCondition(listed.exitCode === 0, 'Unable to inspect package archive')
    const entries = listed.stdout
      .toString()
      .split(/\r?\n/u)
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
        (entry) =>
          entry.startsWith('package/src/') ||
          entry.startsWith('package/tests/') ||
          entry.includes('node_modules')
      ),
      'Archive contains development files'
    )
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

await assertManifest()
await assertRepositoryIntegration()
await assertCoreIsolation()
await assertGeneratedPackage()
await assertPackedArtifact()
console.log('better-effect-http package boundaries passed')
