import { cp, mkdtemp, mkdir, readFile, realpath, readdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))
const childSource = join(packageRoot, 'tests/helpers/bun-package-child.mjs')

const localImportPattern = /(?:from\s+|import\s*(?:\(\s*)?)?["']((?:\.{1,2}\/)[^"']+\.mjs)["']/gu

const readGraph = async (entry: string, declaration: boolean): Promise<string> => {
  const visited = new Set<string>()
  const sources: string[] = []

  const visit = async (path: string): Promise<void> => {
    const resolved = resolve(path)

    if (visited.has(resolved)) {
      return
    }

    visited.add(resolved)
    const source = await readFile(resolved, 'utf8')
    sources.push(source)

    for (const match of source.matchAll(localImportPattern)) {
      const specifier = match[1]

      if (specifier !== undefined) {
        const localPath = join(dirname(resolved), specifier)
        await visit(declaration ? localPath.replace(/\.mjs$/u, '.d.mts') : localPath)
      }
    }
  }

  await visit(entry)
  return sources.join('\n')
}

const assertCoreGraphIsolation = async (): Promise<void> => {
  const forbidden = [/\bBun\s*(?:\.|<)/u, /(?:from|import)\s*(?:type\s+)?["']bun(?::|["'])/iu]

  for (const entry of ['index.mjs', 'web.mjs']) {
    const runtimeGraph = await readGraph(join(packageRoot, 'dist', entry), false)
    const declarationGraph = await readGraph(
      join(packageRoot, 'dist', entry.replace(/\.mjs$/u, '.d.mts')),
      true
    )

    for (const pattern of forbidden) {
      if (pattern.test(runtimeGraph) || pattern.test(declarationGraph)) {
        throw new Error(`Core ${entry} graph unexpectedly depends on Bun: ${pattern}`)
      }
    }
  }

  const bunDeclarations = await readGraph(join(packageRoot, 'dist/bun.d.mts'), true)

  if (!/\bBun\.Server\b/u.test(bunDeclarations)) {
    throw new Error('Bun declaration graph does not expose Bun server types')
  }

  if (
    !/declare class BunEffect<Provided extends AnyService = never,\s*Failure = unknown,/u.test(
      bunDeclarations
    )
  ) {
    throw new Error('BunEffect declarations lost the safe never environment default')
  }
}

const run = async (
  command: readonly string[],
  environment: Record<string, string | undefined> = process.env,
  cwd = packageRoot
): Promise<void> => {
  const child = Bun.spawn([...command], {
    cwd,
    env: environment,
    stdout: 'inherit',
    stderr: 'inherit'
  })
  const exitCode = await child.exited

  if (exitCode !== 0) {
    throw new Error(`Command failed with exit code ${exitCode}: ${command.join(' ')}`)
  }
}

const findArchive = async (directory: string): Promise<string> => {
  const archive = (await readdir(directory)).find(
    (entry) => entry.startsWith('better-effect-') && entry.endsWith('.tgz')
  )

  if (archive === undefined) {
    throw new Error('Fresh better-effect package archive was not created')
  }

  return join(directory, archive)
}

const unpackPackage = async (archive: string, directory: string): Promise<string> => {
  const consumer = join(directory, 'consumer')
  const nodeModules = join(consumer, 'node_modules')
  const packageDirectory = join(nodeModules, 'better-effect')

  await mkdir(nodeModules, { recursive: true })
  await run(['tar', '-xzf', archive, '-C', nodeModules])
  await rename(join(nodeModules, 'package'), packageDirectory)

  const betterResult = await realpath(join(packageRoot, 'node_modules/better-result'))
  await cp(betterResult, join(nodeModules, 'better-result'), {
    dereference: true,
    recursive: true
  })
  await cp(childSource, join(consumer, 'bun-package-child.mjs'))

  return consumer
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'better-effect-bun-package-'))

try {
  await rm(join(packageRoot, 'dist'), { force: true, recursive: true })
  await run([process.execPath, 'run', 'build'])
  await assertCoreGraphIsolation()
  await run([
    process.execPath,
    'pm',
    'pack',
    '--destination',
    temporaryDirectory,
    '--ignore-scripts'
  ])

  const consumer = await unpackPackage(await findArchive(temporaryDirectory), temporaryDirectory)
  await run([process.execPath, 'bun-package-child.mjs'], process.env, consumer)
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true })
}

console.log('Fresh packed BunEffect subpath smoke test passed')
