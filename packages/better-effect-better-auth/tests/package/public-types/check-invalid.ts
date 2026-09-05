import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const fixtureRoot = join(packageRoot, 'tests/package/public-types/invalid')
const compilerOptions = {
  exactOptionalPropertyTypes: true,
  lib: ['ES2022', 'DOM', 'ESNext.Disposable'],
  module: 'ESNext',
  moduleResolution: 'bundler',
  noEmit: true,
  noUncheckedIndexedAccess: true,
  skipLibCheck: true,
  strict: true,
  target: 'ES2022'
}

const fixtures = [
  { name: 'absent-plugin-endpoint', expected: ['listUsers'] },
  { name: 'incomplete-service-override', expected: ['session'] },
  { name: 'missing-layer', expected: ['missingServices'] },
  { name: 'transport-flags', expected: ['asResponse', 'returnHeaders', 'returnStatus'] }
] as const

const decoder = new TextDecoder()

const assertCondition: (condition: boolean, message: string) => asserts condition = (
  condition,
  message
) => {
  if (!condition) {
    throw new Error(message)
  }
}

const run = (command: string[], cwd: string) => {
  const result = Bun.spawnSync(command, {
    cwd,
    stderr: 'pipe',
    stdout: 'pipe'
  })

  return {
    exitCode: result.exitCode,
    output: `${decoder.decode(result.stdout)}\n${decoder.decode(result.stderr)}`
  }
}

const checkFixture = async (
  fixture: (typeof fixtures)[number],
  compiler: readonly string[],
  label: string,
  root: string
): Promise<void> => {
  const configPath = join(root, `${fixture.name}-${label}.json`)
  const sourcePath = join(fixtureRoot, `${fixture.name}.ts`)
  await writeFile(
    configPath,
    JSON.stringify({
      compilerOptions,
      files: [sourcePath]
    })
  )

  const result = run([...compiler, '--pretty', 'false', '-p', configPath], packageRoot)
  assertCondition(result.exitCode !== 0, `${fixture.name} unexpectedly compiled with ${label}`)
  assertCondition(
    !result.output.includes('TS2307'),
    `${fixture.name} has a broken import under ${label}:\n${result.output}`
  )

  for (const expected of fixture.expected) {
    assertCondition(
      result.output.includes(expected),
      `${fixture.name} did not report ${expected} under ${label}:\n${result.output}`
    )
  }
}

const main = async (): Promise<void> => {
  const tempRoot = await mkdtemp(join(packageRoot, '.invalid-public-types-'))

  try {
    const current = [join(packageRoot, 'node_modules/.bin/tsc')]

    for (const fixture of fixtures) {
      await checkFixture(fixture, current, 'current', tempRoot)
    }
  } finally {
    await rm(tempRoot, { force: true, recursive: true })
  }

  console.log('public Better Auth negative type fixtures passed')
}

await main()
