import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = fileURLToPath(new URL('../../../', import.meta.url))
const distRoot = join(packageRoot, 'dist')
const rootDeclaration = join(distRoot, 'index.d.mts')

const assertCondition = (condition: boolean, message: string): asserts condition => {
  if (!condition) {
    throw new Error(message)
  }
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

    const localReferences = source.matchAll(
      /(?:\bfrom\s+|\bimport\s*\(\s*)["']((?:\.{1,2}\/)[^"']+\.mjs)["']/g
    )

    for (const match of localReferences) {
      const specifier = match[1]

      assertCondition(specifier !== undefined, `Invalid declaration import in ${path}`)

      await visit(resolve(dirname(path), specifier.replace(/\.mjs$/, '.d.mts')))
    }
  }

  await visit(entry)

  return sources.join('\n')
}

const declarations = await readDeclarationGraph(rootDeclaration)
const rootSource = await readFile(rootDeclaration, 'utf8')
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
  new RegExp(`declare const ${serviceMarkerName}: unique symbol;`).test(declarations),
  'Generated Service phantom key is not a unique symbol'
)
assertCondition(
  new RegExp(`interface ${serviceVarianceName}<out Tag extends string, in out Instance>`).test(
    declarations
  ),
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
  new RegExp(`declare const ${layerMarkerName}: unique symbol;`).test(declarations),
  'Generated Layer phantom key is not a unique symbol'
)
assertCondition(
  new RegExp(`interface ${layerVarianceName}<in out Specs, out Collisions>`).test(declarations),
  'Generated Layer marker lost its variance declaration'
)

const rootExportsLayerSpec =
  /\bexport\s+(?:declare\s+)?(?:type|interface|class)\s+LayerSpec\b/.test(rootSource) ||
  /\bexport\s+(?:type\s+)?\{[^}]*\bLayerSpec\b[^}]*\}/s.test(rootSource)

assertCondition(
  !rootExportsLayerSpec,
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
