import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
function replace(text, before, after, count = 1) {
  assert.equal(text.split(before).length - 1, count, `Unexpected source anchor count: ${before}`)
  return text.replaceAll(before, after)
}
function region(text, begin, end, transform) {
  const start = text.indexOf(begin)
  const finish = text.indexOf(end, start + begin.length)
  assert.ok(start >= 0 && finish > start, `Missing region ${begin}`)
  return text.slice(0, start) + transform(text.slice(start, finish)) + text.slice(finish)
}
function edit(path, transform) { writeFileSync(path, transform(readFileSync(path, 'utf8'))) }

edit('packages/better-effect-mq/src/store/flow-v2.ts', (text) => replace(text,
  'export interface FlowStoreV2Descriptor {',
  `export interface FlowStoreV2Descriptor {
  /** A handoff atomically releases the parent job lease on successful fan-out.
   * Collect must acquire a new lease. Omission preserves the retained-lease lifecycle
   * of existing independent/reference FlowStores; never infer this from parent.state. */
  readonly parentLeaseMode?: 'retained' | 'handoff'`))

edit('packages/better-effect-mq-postgres/src/flow.ts', (text) => replace(text,
  'const flowDescriptor: FlowStoreV2Descriptor = Object.freeze({',
  "const flowDescriptor: FlowStoreV2Descriptor = Object.freeze({\n  parentLeaseMode: 'handoff',"))

edit('packages/better-effect-mq/src/worker/supervisor.ts', (text) => {
  text = replace(text, '  terminalNotified?: boolean', `  terminalNotified?: boolean
  /** The durable store acknowledged release of this phase's lease. */
  flowHandoff?: boolean`)
  text = replace(text, '    this.flowStores = flowStores', `    this.flowStores = flowStores
    for (const store of flowStores.values()) {
      const mode = store.descriptor.parentLeaseMode
      if (mode !== undefined && mode !== 'retained' && mode !== 'handoff') {
        throw new JobDefinitionError({ field: 'flows.parentLeaseMode', message: 'unsupported parent lease lifecycle' })
      }
    }`)
  text = replace(text, `    // A Flow parent remains admitted while its children run so its lease can be
    // renewed and its execution Scope stays alive. It must not consume the only
    // ordinary Worker slot, otherwise a concurrency-1 Worker deadlocks after fanOut.`,
    `    // Handoff-mode phases occupy ordinary capacity only until durable fan-out.
    // Retained-lease reference adapters keep their existing separate admission model.`)
  text = replace(text, 'this.activeNonFlowAttempts()', 'this.occupiedSlots()', 2)
  text = replace(text, '  private activeNonFlowAttempts(): number {', `  private usesFlowLeaseHandoff(route: FlowRoute | undefined): boolean {
    return route !== undefined &&
      this.flowStores.get(route.parentFlowStore.serviceTag)?.descriptor.parentLeaseMode === 'handoff'
  }

  private occupiedSlots(): number {`)
  text = replace(text, '      if (attempt.entry.flow === undefined) count += 1',
    '      if (!attempt.flowHandoff && (attempt.entry.flow === undefined || this.usesFlowLeaseHandoff(attempt.entry.flow))) count += 1')
  text = replace(text, `        attempt.entry.flow === undefined &&
        attempt.entry.queue === group.queue`,
    `        !attempt.flowHandoff &&
        (attempt.entry.flow === undefined || this.usesFlowLeaseHandoff(attempt.entry.flow)) &&
        attempt.entry.queue === group.queue`)
  text = region(text, '  private async executeAttempt(', '  private async executeFlowProgram(', (part) => {
    part = replace(part, "if (attempt.state === 'lost') return", "if (attempt.state === 'lost' || attempt.flowHandoff) return", 2)
    return replace(part, 'if (this.isLost(attempt)) return', 'if (this.isLost(attempt) || attempt.flowHandoff) return')
  })
  text = replace(text, '      if (Result.isError(fanOut)) return Result.err(fanOut.error)\n      this.rememberFlowId(route, flowId)',
    `      if (Result.isError(fanOut)) return Result.err(fanOut.error)
      if (this.usesFlowLeaseHandoff(route)) {
        // The successful native transaction owns the manifest now. Do not encode
        // this phase as the parent result or settle/release its relinquished lease.
        attempt.flowHandoff = true
        attempt.timeoutCancel?.()
        this.rememberFlowId(route, flowId)
        await this.enqueueFlowChildren(route, specs.value)
        this.requestFlowRelay()
        return Result.ok(undefined)
      }
      this.rememberFlowId(route, flowId)`)
  text = replace(text, `    const settled = await this.awaitFlow(route, flowId, attempt.controller.signal)
    if (Result.isError(settled)) return Result.err(settled.error)
    snapshot = settled.value`,
    `    if (this.usesFlowLeaseHandoff(route)) {
      // This invocation was admitted by a new native claim. The manifest's token
      // can be archival, so it is not a replacement for the claimed job's lease.
      if (snapshot.parent.state !== 'active' || snapshot.parent.flow.pending !== 0) {
        const error = new LeaseLostError({ jobId: flowId, leaseToken: attempt.job.leaseToken, reason: 'missing-lease' })
        this.markLost(attempt, error)
        return Result.err(error)
      }
    } else {
      const settled = await this.awaitFlow(route, flowId, attempt.controller.signal)
      if (Result.isError(settled)) return Result.err(settled.error)
      snapshot = settled.value
    }`)
  text = region(text, '  private async heartbeat(', '  private markLost(', (part) => {
    part = replace(part, "attempt.state !== 'lost' && attempt.state !== 'settling'", "!attempt.flowHandoff && attempt.state !== 'lost' && attempt.state !== 'settling'")
    return replace(part, '        attempt === undefined ||', '        attempt === undefined ||\n        attempt.flowHandoff ||', 2)
  })
  text = region(text, '  private markLost(', '  private ', (part) =>
    replace(part, "if (attempt.state === 'lost') return", "if (attempt.state === 'lost' || attempt.flowHandoff) return"))
  text = region(text, '  private abortActiveAttempts(): void {', '  private async runGroup(', (part) =>
    replace(part, '    for (const attempt of this.activeAttempts.values()) {', '    for (const attempt of this.activeAttempts.values()) {\n      if (attempt.flowHandoff) continue'))
  text = region(text, '  private async sweepFlow(', '  private ', (part) =>
    replace(part, '    const snapshot = current.value', `    const snapshot = current.value
    // An empty manifest is a real flow but has nothing to reconcile/cascade.
    if (snapshot.children.length === 0) return`))
  return text
})

edit('packages/better-effect-mq-postgres/src/store.ts', (text) => {
  text = replace(text, '  private async row(tx: Tx, id: string, lock = false): Promise<JobRecord | undefined> {',
    `  /** Lease maintenance must classify known suspension before invoking the frozen
   * v1 record decoder. The sentinel is private and can never reach a v1 reducer. */
  private async readLeaseRecord(tx: Tx, id: string): Promise<JobRecord | { readonly state: 'waiting-children' } | undefined> {
    const result = await tx.query<Row>(
      \`SELECT \${this.jobColumns().join(',')} FROM \${this.table(POSTGRES_TABLES.jobs)} WHERE namespace=$1 AND id=$2 FOR UPDATE\`,
      [this.client.namespace, id]
    )
    const found = result.rows[0]
    if (found === undefined) return undefined
    if (found.state === 'waiting-children') return { state: 'waiting-children' }
    return decodeJob(found)
  }

  private async row(tx: Tx, id: string, lock = false): Promise<JobRecord | undefined> {`)
  text = region(text, '  async heartbeat(', '  async ', (part) => {
    part = replace(part, 'const r = await this.row(tx, lease.jobId, true)', 'const r = await this.readLeaseRecord(tx, lease.jobId)')
    return replace(part, 'if (r === undefined)', "if (r === undefined || r.state === 'waiting-children')")
  })
  text = region(text, '  async release(', '  async heartbeat(', (part) => {
    part = replace(part, "      return this.transition('release', { jobId: jobId.value, now }, (r) => {", `      return this.withTx('release', async (tx) => {
        const record = await this.readLeaseRecord(tx, jobId.value)
        if (record?.state === 'waiting-children') {
          throw new LeaseLostError({ jobId: jobId.value, leaseToken: leaseToken.value, reason: 'missing-lease' })
        }
        return this.applyTransitionInTx(tx, 'release', { jobId: jobId.value, now }, (r) => {`)
    return replace(part, `      })
    } catch (cause) {`, `        })
      })
    } catch (cause) {`)
  })
  // Both public and controlled settlement implementations hold the job row lock here.
  const pattern = /(\s*)const current = decodeJob\(source\)/g
  let count = 0
  text = text.replace(pattern, (match, indent) => {
    count += 1
    return `${indent}if (source.state === 'waiting-children') {${indent}  throw new LeaseLostError({ jobId: request.jobId as never, leaseToken: request.leaseToken as never, reason: 'missing-lease' })${indent}}${indent}const current = decodeJob(source)`
  })
  assert.equal(count, 2, 'Expected the two locked native settlement implementations')
  return text
})
