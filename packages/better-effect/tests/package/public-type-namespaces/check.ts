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
  Effect: ['Success', 'Error', 'Requirements', 'Any'],
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
  Layer: ['Any', 'Specs', 'Provided', 'Required', 'Missing', 'Complete'],
  Runtime: ['For', 'Options', 'ShutdownDiagnostic'],
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

for (const staleName of ['EffectResult', 'AnyEffectResult']) {
  assertCondition(
    !declarations.includes(staleName),
    `Stale public Effect name remains: ${staleName}`
  )
}

for (const typeMetadata of [
  'ServiceIdentityTypeId',
  'EffectRequirementsTypeId',
  'MissingDependenciesTypeId'
]) {
  assertCondition(
    !esm.includes(typeMetadata),
    `Type metadata leaked into generated ESM: ${typeMetadata}`
  )
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
const decoder = new TextDecoder()
const diagnosticOutput = `${decoder.decode(diagnostic.stdout)}\n${decoder.decode(diagnostic.stderr)}`

assertCondition(diagnostic.exitCode !== 0, 'Invalid Runtime fixture unexpectedly typechecked')
assertCondition(
  /MissingDependencies\s*<\s*Cache\s*>/.test(diagnosticOutput),
  'Runtime diagnostic did not name MissingDependencies<Cache>'
)

console.log('Public type namespace package checks passed')
