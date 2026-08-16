import { readdir, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = fileURLToPath(new URL('../../../', import.meta.url))
const distRoot = resolve(packageRoot, 'dist')
const rootDeclaration = join(distRoot, 'index.d.mts')

const assertCondition = (condition: boolean, message: string): asserts condition => {
  if (!condition) {
    throw new Error(message)
  }
}

const assertInsideDistRoot = (path: string): void => {
  const relativePath = relative(distRoot, path)

  assertCondition(
    relativePath === '' ||
      (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath)),
    `Resolved declaration path escapes dist root: ${path}`
  )
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

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

const readDeclarationGraph = async (entry: string): Promise<Map<string, string>> => {
  const visited = new Set<string>()
  const sources = new Map<string, string>()

  const visit = async (path: string): Promise<void> => {
    const declarationPath = resolve(path)

    assertInsideDistRoot(declarationPath)

    if (visited.has(declarationPath)) {
      return
    }

    visited.add(declarationPath)

    const source = await readFile(declarationPath, 'utf8')
    sources.set(declarationPath, source)

    const localReferences = source.matchAll(
      /(?:\bfrom\s+|\bimport\s*\(\s*)["']((?:\.{1,2}\/)[^"']+\.mjs)["']/g
    )

    for (const match of localReferences) {
      const specifier = match[1]

      assertCondition(specifier !== undefined, `Invalid declaration import in ${declarationPath}`)

      await visit(resolve(dirname(declarationPath), specifier.replace(/\.mjs$/, '.d.mts')))
    }
  }

  await visit(entry)

  return sources
}

const declarationSources = await readDeclarationGraph(rootDeclaration)
const declarations = [...declarationSources.values()].join('\n')
const rootSource = declarationSources.get(rootDeclaration)

assertCondition(rootSource !== undefined, `Missing root declaration source: ${rootDeclaration}`)
const files = await collectFiles(distRoot)
const esmFiles = files.filter((path) => path.endsWith('.mjs'))
const esm = (await Promise.all(esmFiles.map((path) => readFile(path, 'utf8')))).join('\n')

const serviceStatics = declarations.match(
  /type ServiceStatics<out Tag extends string, in out Instance>\s*=\s*\{([\s\S]*?)\n?\};/
)

assertCondition(serviceStatics !== null, 'Generated declarations lost ServiceStatics variance')

const serviceStaticsBody = serviceStatics[1]

assertCondition(serviceStaticsBody !== undefined, 'Generated ServiceStatics has no body')
assertCondition(
  /readonly of: \(this: void, implementation: Instance\) => Instance;/.test(serviceStaticsBody),
  'Generated ServiceStatics lost its function-property contract'
)

const serviceMarker = serviceStaticsBody.match(
  /readonly \[([A-Za-z_$][\w$]*)\]: ([A-Za-z_$][\w$]*)<Tag, Instance>;/
)

assertCondition(serviceMarker !== null, 'Generated ServiceStatics lost its phantom marker')

const serviceMarkerName = serviceMarker[1]
const serviceVarianceName = serviceMarker[2]

assertCondition(serviceMarkerName !== undefined, 'Generated Service marker name is missing')
assertCondition(serviceVarianceName !== undefined, 'Generated Service variance name is missing')
assertCondition(
  new RegExp(`declare const ${escapeRegExp(serviceMarkerName)}: unique symbol;`).test(declarations),
  'Generated Service phantom key is not a unique symbol'
)
assertCondition(
  new RegExp(
    `interface ${escapeRegExp(serviceVarianceName)}<out Tag extends string, in out Instance>`
  ).test(declarations),
  'Generated Service marker lost its variance declaration'
)
assertCondition(
  /interface ServiceToken<out Tag extends string = string, in out Instance = any>\s+extends AbstractServiceConstructor<Instance>,\s*ServiceStatics<Tag, Instance>/.test(
    declarations
  ),
  'Generated ServiceToken lost its public variance contract'
)
assertCondition(
  /type [A-Za-z_$][\w$]*\s*=\s*Layer<any, any>\s*\|\s*Layer<never, any>/.test(declarations),
  'Generated Layer.Any boundary lost its never-Specs branch'
)
assertCondition(
  /type LayerSpec<out Provided extends AnyServiceToken, out Required extends AnyServiceToken = never>/.test(
    declarations
  ),
  'Generated declarations lost LayerSpec covariance'
)
assertCondition(
  /interface ServiceRequirement<out T extends AnyServiceToken>/.test(declarations),
  'Generated declarations lost ServiceRequirement covariance'
)

const layerMarker = declarations.match(
  /declare class Layer<in out Specs extends AnyLayerSpec = AnyLayerSpec, out Collisions extends AnyServiceToken = never>\s*\{\s*readonly \[([A-Za-z_$][\w$]*)\]: ([A-Za-z_$][\w$]*)<Specs, Collisions>;/
)

assertCondition(layerMarker !== null, 'Generated Layer lost its variance marker')

const layerMarkerName = layerMarker[1]
const layerVarianceName = layerMarker[2]

assertCondition(layerMarkerName !== undefined, 'Generated Layer marker name is missing')
assertCondition(layerVarianceName !== undefined, 'Generated Layer variance name is missing')
assertCondition(
  new RegExp(`declare const ${escapeRegExp(layerMarkerName)}: unique symbol;`).test(declarations),
  'Generated Layer phantom key is not a unique symbol'
)
assertCondition(
  new RegExp(`interface ${escapeRegExp(layerVarianceName)}<in out Specs, out Collisions>`).test(
    declarations
  ),
  'Generated Layer marker lost its variance declaration'
)

const rootExportsLayerSpec =
  /\bexport\s+(?:declare\s+)?(?:type|interface|class)\s+LayerSpec\b/.test(rootSource) ||
  /\bexport\s+(?:type\s+)?\{[^}]*\bLayerSpec\b[^}]*\}/s.test(rootSource)

const hasLayerSpecExport = (source: string): boolean =>
  /\bexport\s+(?:declare\s+)?(?:type|interface|class)\s+LayerSpec\b/.test(source) ||
  /\bexport\s+(?:type\s+)?\{[^}]*\bLayerSpec\b[^}]*\}/s.test(source)

const rootStarExportsLayerSpec = (() => {
  const visited = new Set<string>()

  const visit = (path: string): boolean => {
    if (visited.has(path)) {
      return false
    }

    visited.add(path)

    const source = declarationSources.get(path)

    assertCondition(source !== undefined, `Missing declaration source: ${path}`)

    if (hasLayerSpecExport(source)) {
      return true
    }

    for (const match of source.matchAll(
      /\bexport\s+(?:type\s+)?\*\s+from\s+["']((?:\.{1,2}\/)[^"']+\.mjs)["']/g
    )) {
      const specifier = match[1]

      assertCondition(specifier !== undefined, `Invalid declaration star export in ${path}`)

      const declarationPath = resolve(dirname(path), specifier.replace(/\.mjs$/, '.d.mts'))

      assertInsideDistRoot(declarationPath)

      if (visit(declarationPath)) {
        return true
      }
    }

    return false
  }

  for (const match of rootSource.matchAll(
    /\bexport\s+(?:type\s+)?\*\s+from\s+["']((?:\.{1,2}\/)[^"']+\.mjs)["']/g
  )) {
    const specifier = match[1]

    assertCondition(specifier !== undefined, 'Invalid root declaration star export')

    const declarationPath = resolve(dirname(rootDeclaration), specifier.replace(/\.mjs$/, '.d.mts'))

    assertInsideDistRoot(declarationPath)

    if (visit(declarationPath)) {
      return true
    }
  }

  return false
})()

assertCondition(
  !rootExportsLayerSpec && !rootStarExportsLayerSpec,
  'LayerSpec was unexpectedly promoted to a package-root export'
)

for (const typeOnlyName of [
  serviceMarkerName,
  serviceVarianceName,
  layerMarkerName,
  layerVarianceName
]) {
  assertCondition(
    !esm.includes(typeOnlyName),
    `Type-only variance metadata leaked into generated ESM as ${typeOnlyName}`
  )
}

const built = await import(pathToFileURL(join(distRoot, 'index.mjs')).href)
const service = built.Service()('VarianceArtifactService')
const layer = built.Layer.make(service)
const serviceSymbols = Object.getOwnPropertySymbols(service)
const layerSymbols = Object.getOwnPropertySymbols(layer)

assertCondition(
  serviceSymbols.length === 1 && serviceSymbols[0] === Symbol.asyncIterator,
  'Service variance metadata created an unexpected runtime symbol property'
)
assertCondition(
  layerSymbols.length === 0,
  'Layer variance metadata created a runtime symbol property'
)

console.log('Public type variance package checks passed')
