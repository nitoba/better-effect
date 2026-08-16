import { readdir, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = fileURLToPath(new URL('../../../', import.meta.url))
const distRoot = await realpath(resolve(packageRoot, 'dist'))

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

const canonicalizeDeclarationPath = async (path: string): Promise<string> => {
  const declarationPath = await realpath(resolve(path))

  assertInsideDistRoot(declarationPath)

  return declarationPath
}

const rootDeclaration = await canonicalizeDeclarationPath(join(distRoot, 'index.d.mts'))

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const stripDeclarationComments = (source: string): string => {
  let stripped = ''
  let quote: string | undefined

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]

    if (quote !== undefined) {
      stripped += character

      if (character === '\\') {
        const escaped = source[index + 1]

        if (escaped !== undefined) {
          stripped += escaped
          index += 1
        }
      } else if (character === quote) {
        quote = undefined
      }

      continue
    }

    if (character === "'" || character === '"' || character === '`') {
      stripped += character
      quote = character
      continue
    }

    if (character === '/' && source[index + 1] === '/') {
      const commentStart = index

      index += 2

      while (index < source.length && source[index] !== '\r' && source[index] !== '\n') {
        index += 1
      }

      stripped += source.slice(commentStart, index).replace(/[^\r\n]/g, ' ')
      index -= 1
      continue
    }

    if (character === '/' && source[index + 1] === '*') {
      const commentStart = index

      index += 2

      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        index += 1
      }

      if (index < source.length) {
        index += 2
      }

      stripped += source.slice(commentStart, index).replace(/[^\r\n]/g, ' ')
      index -= 1
      continue
    }

    stripped += character
  }

  return stripped
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

const readDeclarationGraph = async (entry: string): Promise<Map<string, string>> => {
  const visited = new Set<string>()
  const sources = new Map<string, string>()

  const visit = async (path: string): Promise<void> => {
    const declarationPath = await canonicalizeDeclarationPath(path)

    if (visited.has(declarationPath)) {
      return
    }

    visited.add(declarationPath)

    const source = await readFile(declarationPath, 'utf8')
    sources.set(declarationPath, source)

    const localReferences = stripDeclarationComments(source).matchAll(
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
const esm = (
  await Promise.all(
    esmFiles.map(async (path) => readFile(await canonicalizeDeclarationPath(path), 'utf8'))
  )
).join('\n')

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

const exportedLayerSpecPattern = /\bexport\s+(?:declare\s+)?(?:type|interface|class)\s+LayerSpec\b/
const exportedLayerSpecListPattern = /\bexport\s+(?:type\s+)?\{[^}]*\bLayerSpec\b[^}]*\}/s
const localStarExportPattern =
  /\bexport\s+(?:type\s+)?\*\s+from\s+["']((?:\.{1,2}\/)[^"']+\.mjs)["']/g

const hasLayerSpecExport = (source: string): boolean =>
  exportedLayerSpecPattern.test(source) || exportedLayerSpecListPattern.test(source)

const rootExportsLayerSpec = hasLayerSpecExport(stripDeclarationComments(rootSource))

const rootStarExportsLayerSpec = await (async () => {
  const visited = new Set<string>()

  const visit = async (path: string): Promise<boolean> => {
    const declarationPath = await canonicalizeDeclarationPath(path)

    if (visited.has(declarationPath)) {
      return false
    }

    visited.add(declarationPath)

    const source = declarationSources.get(declarationPath)

    assertCondition(source !== undefined, `Missing declaration source: ${declarationPath}`)

    const strippedSource = stripDeclarationComments(source)

    if (hasLayerSpecExport(strippedSource)) {
      return true
    }

    for (const match of strippedSource.matchAll(localStarExportPattern)) {
      const specifier = match[1]

      assertCondition(
        specifier !== undefined,
        `Invalid declaration star export in ${declarationPath}`
      )

      const referencedPath = resolve(
        dirname(declarationPath),
        specifier.replace(/\.mjs$/, '.d.mts')
      )

      if (await visit(referencedPath)) {
        return true
      }
    }

    return false
  }

  for (const match of stripDeclarationComments(rootSource).matchAll(localStarExportPattern)) {
    const specifier = match[1]

    assertCondition(specifier !== undefined, 'Invalid root declaration star export')

    const referencedPath = resolve(dirname(rootDeclaration), specifier.replace(/\.mjs$/, '.d.mts'))

    if (await visit(referencedPath)) {
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
