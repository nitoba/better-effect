import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = fileURLToPath(new URL('../../../', import.meta.url))
const distRoot = join(packageRoot, 'dist')
const rootDeclaration = join(distRoot, 'index.d.mts')

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

const assertCondition = (condition: boolean, message: string): asserts condition => {
  if (!condition) {
    throw new Error(message)
  }
}

const decoder = new TextDecoder()

const readDeclarationGraph = async (entry: string): Promise<string> => {
  const visited = new Set<string>()
  const sources: string[] = []

  const visit = async (path: string): Promise<void> => {
    if (visited.has(path)) {
      return
    }

    visited.add(path)

    const source = await readFile(path, 'utf8')
    sources.push(source)

    const localImports = source.matchAll(/\bfrom\s+["'](\.\/[^"']+\.mjs)["']/g)

    for (const match of localImports) {
      const specifier = match[1]

      assertCondition(specifier !== undefined, `Invalid declaration import in ${path}`)

      const declarationPath = join(dirname(path), specifier.slice(2).replace(/\.mjs$/, '.d.mts'))

      await visit(declarationPath)
    }
  }

  await visit(entry)

  return sources.join('\n')
}

const aliases = {
  Effect: ['Program', 'Success', 'Error', 'Requirements', 'Any'],
  Service: [
    'Any',
    'Identity',
    'Token',
    'Class',
    'Instance',
    'Tag',
    'TokenOf',
    'Contract',
    'FactoryOf',
    'Requirements'
  ],
  Layer: ['Any', 'Provided', 'Required', 'Missing', 'Complete'],
  Runtime: ['For', 'Options', 'ShutdownDiagnostic', 'Inspection', 'ExecutionInspection'],
  Scope: ['Closeable', 'Outcome', 'Finalizer', 'Disposable']
} satisfies Record<string, readonly string[]>

const files = await collectFiles(distRoot)
const esmFiles = files.filter((path) => path.endsWith('.mjs'))

assertCondition(esmFiles.length > 0, 'No generated .mjs files were found')

const declarations = await readDeclarationGraph(rootDeclaration)
const esm = (await Promise.all(esmFiles.map((path) => readFile(path, 'utf8')))).join('\n')

for (const [namespaceName, members] of Object.entries(aliases)) {
  const namespaceMatch = declarations.match(
    new RegExp(`declare namespace ${namespaceName}\\s*\\{([\\s\\S]*?)\\n\\}`)
  )

  assertCondition(namespaceMatch !== null, `Missing declaration namespace ${namespaceName}`)

  const namespaceBody = namespaceMatch[1]

  assertCondition(namespaceBody !== undefined, `Missing body for namespace ${namespaceName}`)

  for (const member of members) {
    const aliasPattern = new RegExp(`\\btype\\s+${member}(?:\\s*<|\\s*=)`)

    assertCondition(
      aliasPattern.test(namespaceBody),
      `Missing declaration alias ${namespaceName}.${member}`
    )

    const assignmentPattern = new RegExp(
      `\\b${namespaceName}\\s*(?:\\.${member}|\\[["']${member}["']\\])\\s*=`
    )

    assertCondition(
      !assignmentPattern.test(esm),
      `Unexpected runtime assignment for ${namespaceName}.${member}`
    )
  }

  const namespaceIifePattern = new RegExp(`\\(\\s*function\\s*\\(\\s*${namespaceName}\\s*\\)`)

  assertCondition(!namespaceIifePattern.test(esm), `Unexpected namespace IIFE for ${namespaceName}`)

  if (namespaceName === 'Layer') {
    assertCondition(
      !/\btype\s+Specs(?:\s*<|\s*=)/.test(namespaceBody),
      'Removed Layer namespace members remain'
    )
  }
}

const built = await import(pathToFileURL(join(distRoot, 'index.mjs')).href)
const runtimeNamespaces = new Map<string, object>([
  ['Effect', built.Effect],
  ['Service', built.Service],
  ['Layer', built.Layer],
  ['Runtime', built.Runtime],
  ['Scope', built.Scope]
])

for (const [namespaceName, members] of Object.entries(aliases)) {
  const value = runtimeNamespaces.get(namespaceName)

  assertCondition(value !== undefined, `Missing runtime export ${namespaceName}`)

  for (const member of members) {
    assertCondition(
      !Object.prototype.hasOwnProperty.call(value, member),
      `Type alias leaked to runtime as ${namespaceName}.${member}`
    )
  }
}

const webDeclarations = await readDeclarationGraph(
  join(distRoot, 'web.mjs').replace(/\.mjs$/, '.d.mts')
)
const webEsm = await readFile(join(distRoot, 'web.mjs'), 'utf8')
const webAliases = ['Options', 'Success', 'ResponseLike', 'Program', 'Value', 'Failure'] as const
const webNamespaceMatch = webDeclarations.match(/declare namespace WebEffect\s*\{([\s\S]*?)\n\}/)

assertCondition(webNamespaceMatch !== null, 'Missing declaration namespace WebEffect')
const webNamespaceBody = webNamespaceMatch[1]
assertCondition(webNamespaceBody !== undefined, 'Missing WebEffect namespace body')

for (const member of webAliases) {
  assertCondition(
    new RegExp(`\\btype\\s+${member}(?:\\s*<|\\s*=)`).test(webNamespaceBody),
    `Missing declaration alias WebEffect.${member}`
  )
  assertCondition(
    !new RegExp(`\\bWebEffect\\s*(?:\\.${member}|\\[["']${member}["']\\])\\s*=`).test(webEsm),
    `Unexpected runtime assignment for WebEffect.${member}`
  )
}

assertCondition(
  !/\(\s*function\s*\(\s*WebEffect\s*\)/.test(webEsm),
  'Unexpected WebEffect namespace IIFE'
)
assertCondition(
  !/\btype\s+RequestLayer(?:\s*<|\s*=)/.test(webNamespaceBody),
  'Removed WebEffect.RequestLayer alias remains'
)

const web = await import(pathToFileURL(join(distRoot, 'web.mjs')).href)
assertCondition(web.WebEffect !== undefined, 'Missing WebEffect runtime export')
assertCondition(
  web.WebEffectSerializationError !== undefined,
  'Missing WebEffectSerializationError runtime export'
)
for (const member of ['defaultFailure', 'defaultSuccess']) {
  assertCondition(
    !Object.prototype.hasOwnProperty.call(web, member),
    `Unexpected internal WebEffect export: ${member}`
  )
}
for (const member of webAliases) {
  assertCondition(
    !Object.prototype.hasOwnProperty.call(web.WebEffect, member),
    `Type alias leaked to runtime as WebEffect.${member}`
  )
}

for (const staleName of [
  'EffectResult',
  'AnyEffectResult',
  'LayerSpec',
  'AnyLayerSpec',
  'LayerSpecs',
  'AnyLayer',
  'LayerProvided',
  'LayerRawRequired',
  'LayerMissing',
  'CompleteLayer'
]) {
  assertCondition(
    !declarations.includes(staleName),
    `Stale public Effect name remains: ${staleName}`
  )
}

for (const typeMetadata of [
  'ServiceIdentityTypeId',
  'EffectRequirementsTypeId',
  'MissingDependenciesTypeId',
  'LayerProvenanceTypeId'
]) {
  assertCondition(
    !esm.includes(typeMetadata),
    `Type metadata leaked into generated ESM: ${typeMetadata}`
  )
}

const invalidLayerExports = [
  {
    label: 'current TypeScript',
    command: [
      'bun',
      'run',
      '--silent',
      'tsc',
      '--',
      '-p',
      'tests/package/public-type-namespaces/tsconfig.invalid-layer-exports.json',
      '--pretty',
      'false'
    ]
  }
] as const

const invalidWebSource = await readFile(
  join(packageRoot, 'tests/package/public-type-namespaces/invalid-web.ts'),
  'utf8'
)
const invalidWebFixtures = [
  {
    label: 'current TypeScript',
    command: [
      'bun',
      'run',
      '--silent',
      'tsc',
      '--',
      '-p',
      'tests/package/public-type-namespaces/tsconfig.invalid-web.json',
      '--pretty',
      'false'
    ]
  }
] as const

for (const fixture of invalidWebFixtures) {
  const result = Bun.spawnSync(fixture.command, {
    cwd: packageRoot,
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const output = `${decoder.decode(result.stdout)}\n${decoder.decode(result.stderr)}`

  assertCondition(
    result.exitCode !== 0,
    `Invalid Web request-layer fixture unexpectedly typechecked under ${fixture.label}`
  )

  const line =
    invalidWebSource.split('\n').findIndex((candidate) => candidate.includes('requestLayer:')) + 1

  assertCondition(line > 0, 'Missing invalid Web request-layer fixture line')
  assertCondition(
    new RegExp(`invalid-web\\.ts\\((?:${line - 1}|${line}),`).test(output),
    `Incompatible root request override was not rejected under ${fixture.label}`
  )
}

const removedLayerNames = [
  'AnyLayer',
  'AnyLayerSpec',
  'CompleteLayer',
  'LayerMissing',
  'LayerProvided',
  'LayerRawRequired',
  'LayerSpec',
  'LayerSpecs'
] as const
for (const fixture of invalidLayerExports) {
  const result = Bun.spawnSync(fixture.command, {
    cwd: packageRoot,
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const output = `${decoder.decode(result.stdout)}\n${decoder.decode(result.stderr)}`

  assertCondition(
    result.exitCode !== 0,
    `Invalid Layer export fixture unexpectedly typechecked under ${fixture.label}`
  )

  for (const name of removedLayerNames) {
    const source = await readFile(
      join(packageRoot, 'tests/package/public-type-namespaces/invalid-layer-exports.ts'),
      'utf8'
    )
    const line = source.split('\n').findIndex((candidate) => candidate.includes(name)) + 1

    assertCondition(line > 0, `Missing invalid fixture line for ${name}`)
    assertCondition(
      new RegExp(`invalid-layer-exports\\.ts\\(${line},`).test(output),
      `Removed export ${name} was not rejected at its source line under ${fixture.label}`
    )
  }
}

const diagnostic = Bun.spawnSync(
  [
    'bun',
    'run',
    '--silent',
    'tsc',
    '--',
    '-p',
    'tests/package/public-type-namespaces/tsconfig.diagnostic.json',
    '--pretty',
    'false'
  ],
  {
    cwd: packageRoot,
    stdout: 'pipe',
    stderr: 'pipe'
  }
)
const diagnosticOutput = `${decoder.decode(diagnostic.stdout)}\n${decoder.decode(diagnostic.stderr)}`

assertCondition(diagnostic.exitCode !== 0, 'Invalid Runtime fixture unexpectedly typechecked')
assertCondition(
  /MissingDependencies\s*<\s*Cache\s*>/.test(diagnosticOutput),
  'Runtime diagnostic did not name MissingDependencies<Cache>'
)

console.log('Public type namespace package checks passed')
