import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('../../../', import.meta.url))
const fixtureRoot = join(packageRoot, 'tests/package/instance-requirements')
const outRoot = join(fixtureRoot, 'out')
const decoder = new TextDecoder()

const assertCondition = (condition: boolean, message: string): asserts condition => {
  if (!condition) {
    throw new Error(message)
  }
}

const compilers = [
  {
    name: 'current',
    command: ['bun', 'run', '--silent', 'tsc', '--']
  },
  {
    name: 'ts5.7',
    command: ['bunx', '--bun', '--package', 'typescript@5.7.2', 'tsc']
  }
] as const

interface CompilerResult {
  readonly exitCode: number
  readonly output: string
}

const runCompiler = (
  compiler: (typeof compilers)[number],
  arguments_: readonly string[]
): CompilerResult => {
  const result = Bun.spawnSync([...compiler.command, ...arguments_, '--pretty', 'false'], {
    cwd: packageRoot,
    stdout: 'pipe',
    stderr: 'pipe'
  })

  return {
    exitCode: result.exitCode,
    output: `${decoder.decode(result.stdout)}\n${decoder.decode(result.stderr)}`
  }
}

const requireSuccess = (
  compiler: (typeof compilers)[number],
  config: string,
  extra: readonly string[] = []
): string => {
  const result = runCompiler(compiler, ['-p', config, ...extra])

  assertCondition(
    result.exitCode === 0,
    `${compiler.name} unexpectedly rejected ${config}:\n${result.output}`
  )

  return result.output
}

const requireFailure = (compiler: (typeof compilers)[number], config: string): string => {
  const result = runCompiler(compiler, ['-p', config])

  assertCondition(result.exitCode !== 0, `${compiler.name} unexpectedly accepted ${config}`)

  return result.output
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

const invalidEnvironmentSource = await readFile(join(fixtureRoot, 'invalid-environment.ts'), 'utf8')
const invalidEnvironmentAliases = [
  'InvalidEmptyEnvironment',
  'InvalidObjectEnvironment',
  'InvalidUnknownEnvironment',
  'InvalidRandomEnvironment',
  'InvalidPrimitiveEnvironment'
] as const

try {
  await rm(outRoot, { recursive: true, force: true })

  for (const compiler of compilers) {
    requireSuccess(compiler, 'tests/package/instance-requirements/tsconfig.json')

    const environmentOutput = requireFailure(
      compiler,
      'tests/package/instance-requirements/tsconfig.invalid-environment.json'
    )

    for (const alias of invalidEnvironmentAliases) {
      const line = invalidEnvironmentSource
        .slice(0, invalidEnvironmentSource.indexOf(`export type ${alias}`))
        .split('\n').length

      assertCondition(
        environmentOutput.includes(`invalid-environment.ts(${line},`),
        `${compiler.name} did not reject ${alias}`
      )
    }

    assertCondition(
      environmentOutput.includes('AnyService') || environmentOutput.includes('ServiceIdentity'),
      `${compiler.name} invalid environment diagnostics lost the Service constraint`
    )

    const runtimeOutput = requireFailure(
      compiler,
      'tests/package/instance-requirements/tsconfig.invalid-runtime.json'
    )
    assertCondition(
      /MissingDependencies\s*<\s*Logger\s*\|\s*Cache\s*>/.test(runtimeOutput),
      `${compiler.name} Runtime diagnostic lost MissingDependencies<Logger | Cache>:\n${runtimeOutput}`
    )
    const layerOutput = requireFailure(
      compiler,
      'tests/package/instance-requirements/tsconfig.invalid-layer.json'
    )
    assertCondition(
      /MissingDependencies\s*<\s*Database\s*>/.test(layerOutput),
      `${compiler.name} Layer diagnostic lost MissingDependencies<Database>:\n${layerOutput}`
    )
    assertCondition(
      /missingServices/.test(layerOutput),
      `${compiler.name} Layer diagnostic lost the readable missingServices property:\n${layerOutput}`
    )

    const outputDirectory = join(outRoot, compiler.name)
    const emissionOutput = requireSuccess(
      compiler,
      'tests/package/instance-requirements/tsconfig.emit.json',
      ['--outDir', outputDirectory]
    )

    assertCondition(!emissionOutput.includes('TS4020'), `${compiler.name} reported TS4020`)

    const declarationPath = join(outputDirectory, 'exported-service.d.ts')
    const declaration = await readFile(declarationPath, 'utf8')

    if (!/ServiceIdentity<['"]Database['"]>/.test(declaration)) {
      const identityAlias = declaration.match(
        /import\(["']([^"']+\.mjs)["']\)\.([A-Za-z_$][\w$]*)<["']Database["']>/
      )

      assertCondition(
        identityAlias !== null,
        `${compiler.name} exported subclass declaration lost its named Service identity`
      )

      const moduleSpecifier = identityAlias[1]
      const alias = identityAlias[2]

      assertCondition(
        moduleSpecifier !== undefined && alias !== undefined,
        'Invalid identity alias'
      )

      const declarationModule = await readFile(
        resolve(fixtureRoot, moduleSpecifier.replace(/\.mjs$/, '.d.mts')),
        'utf8'
      )
      assertCondition(
        new RegExp(`\\bServiceIdentity\\s+as\\s+${alias}\\b`).test(declarationModule),
        `${compiler.name} exported subclass identity alias does not resolve to ServiceIdentity`
      )
    }

    const copiedDeclaration = join(fixtureRoot, `emitted-${compiler.name}.d.ts`)
    const emittedConsumer = join(fixtureRoot, `consumer-${compiler.name}.ts`)
    const emittedConfig = join(fixtureRoot, `tsconfig.emitted-${compiler.name}.json`)
    await writeFile(copiedDeclaration, declaration)
    await writeFile(
      emittedConsumer,
      `import type { ServiceIdentity } from 'better-effect'\nimport { Database } from './emitted-${compiler.name}'\n\ndeclare const database: Database\nconst identity: ServiceIdentity<'Database'> = database\nconst query: string = database.query()\nconst structural: Database = Database.of({ query: () => 'structural' })\n\nvoid identity\nvoid query\nvoid structural\n`
    )
    await writeFile(
      emittedConfig,
      `${JSON.stringify(
        {
          compilerOptions: {
            lib: ['ES2022', 'DOM', 'ESNext.Disposable'],
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            skipLibCheck: true,
            noEmit: true,
            types: []
          },
          files: [`consumer-${compiler.name}.ts`]
        },
        undefined,
        2
      )}\n`
    )
    requireSuccess(compiler, emittedConfig)
  }

  const distFiles = await collectFiles(join(packageRoot, 'dist'))
  const esm = (
    await Promise.all(
      distFiles.filter((path) => path.endsWith('.mjs')).map(async (path) => readFile(path, 'utf8'))
    )
  ).join('\n')

  for (const marker of [
    'ServiceIdentityTypeId',
    'EffectRequirementsTypeId',
    'MissingDependenciesTypeId',
    'LayerProvenanceTypeId'
  ]) {
    assertCondition(!esm.includes(marker), `Type metadata leaked into generated ESM: ${marker}`)
  }

  console.log('Instance requirement package checks passed')
} finally {
  await rm(outRoot, { recursive: true, force: true })

  for (const compiler of compilers) {
    await rm(join(fixtureRoot, `emitted-${compiler.name}.d.ts`), { force: true })
    await rm(join(fixtureRoot, `consumer-${compiler.name}.ts`), { force: true })
    await rm(join(fixtureRoot, `tsconfig.emitted-${compiler.name}.json`), { force: true })
  }
}
