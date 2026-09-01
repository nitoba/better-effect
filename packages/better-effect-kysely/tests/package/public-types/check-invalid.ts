import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const fixtureRoot = join(packageRoot, 'tests/package/public-types/invalid')
const compilerOptions = {
  lib: ['ES2022', 'ESNext.Disposable'],
  target: 'ES2022',
  module: 'ESNext',
  moduleResolution: 'bundler',
  strict: true,
  skipLibCheck: true,
  noEmit: true
}
const decoder = new TextDecoder()

const assertCondition: (condition: boolean, message: string) => asserts condition = (
  condition,
  message
) => {
  if (!condition) throw new Error(message)
}

const run = (command: string[], cwd: string) => {
  const result = Bun.spawnSync(command, { cwd, stderr: 'pipe', stdout: 'pipe' })
  return {
    exitCode: result.exitCode,
    output: `${decoder.decode(result.stdout)}\n${decoder.decode(result.stderr)}`
  }
}

const main = async (): Promise<void> => {
  const root = await mkdtemp(join(packageRoot, '.invalid-public-types-'))

  try {
    const configPath = join(root, 'functional-api.json')
    await writeFile(
      configPath,
      JSON.stringify({
        compilerOptions,
        files: [join(fixtureRoot, 'functional-api.ts')]
      })
    )

    for (const compiler of [
      [join(packageRoot, 'node_modules/.bin/tsc')],
      ['bunx', '--bun', '--package', 'typescript@5.7.2', 'tsc']
    ]) {
      const result = run([...compiler, '--pretty', 'false', '-p', configPath], packageRoot)
      assertCondition(result.exitCode !== 0, 'functional-api unexpectedly compiled')
      assertCondition(
        !result.output.includes('TS2307'),
        `functional-api has a broken import:\n${result.output}`
      )
      assertCondition(
        result.output.includes('Kysely') || result.output.includes('Database'),
        `functional-api did not fail for the invalid public API:\n${result.output}`
      )
    }
  } finally {
    await rm(root, { force: true, recursive: true })
  }

  console.log('public Kysely negative type fixtures passed')
}

await main()
