import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// Only instrument the disposable test copy after its unchanged regression failed.
// These diagnostics are not a supported Nest Worker option or a passing qualification.
const directory = join(process.env.RUNNER_TEMP, 'flow-consumer')
const contracts = join(directory, 'flow-contracts.ts')
let source = readFileSync(contracts, 'utf8')
assert.ok(source.includes('@Worker({'))
source = source.replaceAll('@Worker({', '@Worker({ ...nativeDiagnostics,')
source = `const nativeMessages = new Set<string>()
const nativeDiagnostics = {
  onError: (error: Error): void => {
    const key = String(error)
    if (nativeMessages.has(key) || nativeMessages.size >= 12) return
    nativeMessages.add(key)
    console.error('NATIVE FLOW DIAGNOSTIC', error)
  }
}
${source}`
writeFileSync(contracts, source)
const scenario = join(directory, 'flows.ts')
source = readFileSync(scenario, 'utf8')
const stderrHook = "    this.child.stderr?.on('data', (chunk: Buffer) => {"
assert.equal(source.split(stderrHook).length - 1, 1)
source = source.replace(stderrHook, `${stderrHook}\n      process.stderr.write(chunk)`)
const failureHook = "      console.error('FLOW SCENARIO FAILURE', cause)"
assert.equal(source.split(failureHook).length - 1, 1)
source = source.replace(failureHook, `${failureHook}
      for (const table of ['better_effect_mq_flow_children', 'better_effect_mq_flow_outbox']) {
        console.error('PERSISTED FLOW DIAGNOSTIC', table, JSON.stringify((await pool.query(\`SELECT * FROM "\${schema}"."\${table}" LIMIT 30\`)).rows))
      }`)
writeFileSync(scenario, source)
for (const command of [['node', 'node_modules/typescript/bin/tsc', '-p', 'tsconfig.flows.json'], ['node', 'dist/flows.js']]) {
  const result = spawnSync(command[0], command.slice(1), { cwd: directory, stdio: 'inherit', timeout: 45_000 })
  if (result.status !== 0) {
    console.error('Diagnostic command exited', result.status, result.signal, result.error)
    process.exitCode = 1
    break
  }
}
