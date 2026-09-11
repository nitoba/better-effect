import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
const path = 'packages/better-effect-mq/src/worker/supervisor.ts'
let text = readFileSync(path, 'utf8')
function replace(before, after) {
  assert.equal(text.split(before).length - 1, 1, `Missing or repeated anchor: ${before}`)
  text = text.replace(before, after)
}
replace('  private readonly flowIdsByRoute = new Map<string, Set<JobId>>()', `  private readonly flowIdsByRoute = new Map<string, Set<JobId>>()
  private flowSweepRouteCursor = 0
  private readonly flowChildSweepCursors = new Map<string, Map<JobId, string>>()`)
replace('    const source = this.flowSources.get(group.store.serviceTag)', `    // Sources are indexed by FlowStore identity, not by the associated JobStore.
    const source = this.flowSources.get(FlowStore.for(group.store).serviceTag)`)
const start = text.indexOf('  private async sweepFlows(): Promise<void> {')
const end = text.indexOf('  private async sweepFlow(', start)
assert.ok(start >= 0 && end > start)
text = text.slice(0, start) + `  private async sweepFlows(): Promise<void> {
    let remaining = this.workerOptions.flowBatchSize
    let visits = 0
    for (const ids of this.flowIdsByRoute.values()) visits += ids.size
    let emptyRoutes = 0
    while (remaining > 0 && visits > 0 && emptyRoutes < this.flowRoutes.length) {
      const route = this.flowRoutes[this.flowSweepRouteCursor % this.flowRoutes.length]
      this.flowSweepRouteCursor = (this.flowSweepRouteCursor + 1) % this.flowRoutes.length
      if (route === undefined) break
      const ids = this.flowIdsByRoute.get(route.key)
      const flowId = ids?.values().next().value
      if (ids === undefined || flowId === undefined) {
        emptyRoutes += 1
        continue
      }
      emptyRoutes = 0
      // Rotate before I/O: a slow parent or a failed inspection must not pin the
      // next bounded cycle to the same prefix, even across different flow routes.
      ids.delete(flowId)
      ids.add(flowId)
      visits -= 1
      remaining -= Math.max(1, await this.sweepFlow(route, flowId, remaining))
    }
  }

` + text.slice(end)
replace('    // An empty manifest is real but has no children to reconcile or cascade.', `    if (
      isTerminalJobState(snapshot.value.parent.state) &&
      snapshot.value.parent.flow.pending === 0 &&
      snapshot.value.children.every((child) =>
        child.status !== 'pending' && (child.status !== 'cancelled' || child.cascaded)
      )
    ) {
      this.forgetFlowId(route, flowId)
      return 1
    }

    // An empty manifest is real but has no children to reconcile or cascade.`)
replace(`    const observations: FlowChildObservation[] = []
    let inspected = 0
    for (const child of snapshot.value.children) {
      if (child.status !== 'pending' || inspected >= limit) continue
      inspected += 1`, `    const observations: FlowChildObservation[] = []
    const children = snapshot.value.children
    const cursors = this.flowChildSweepCursors.get(route.key) ?? new Map<JobId, string>()
    this.flowChildSweepCursors.set(route.key, cursors)
    const previous = cursors.get(flowId)
    const start = previous === undefined ? -1 : children.findIndex((child) => child.childKey === previous)
    let inspected = 0
    for (let offset = 1; offset <= children.length && inspected < limit; offset += 1) {
      const child = children[(start + offset) % children.length]
      if (child === undefined || child.status !== 'pending') continue
      cursors.set(flowId, child.childKey)
      inspected += 1`)
replace(`  private forgetFlowId(route: FlowRoute, flowId: JobId): void {
    this.flowIdsByRoute.get(route.key)?.delete(flowId)
  }`, `  private forgetFlowId(route: FlowRoute, flowId: JobId): void {
    this.flowIdsByRoute.get(route.key)?.delete(flowId)
    const cursors = this.flowChildSweepCursors.get(route.key)
    cursors?.delete(flowId)
    if (cursors?.size === 0) this.flowChildSweepCursors.delete(route.key)
  }`)
const waitStart = text.indexOf('  private async waitForWork(')
const waitEnd = text.indexOf('  private ', waitStart + 20)
assert.ok(waitStart >= 0 && waitEnd > waitStart)
let wait = text.slice(waitStart, waitEnd)
const anchor = `      (cause) => {
        this.report(cause)
        return 'wake-error'
      }`
assert.equal(wait.split(anchor).length - 1, 1)
wait = wait.replace(anchor, `      (cause) => {
        // Poll/quiesce deliberately abort this notification wait. The operation
        // helper's abort boundary is not an infrastructure deadline in that case.
        if (controller.signal.aborted && cause instanceof StoreOperationTimeoutError) return 'wake'
        this.report(cause)
        return 'wake-error'
      }`)
text = text.slice(0, waitStart) + wait + text.slice(waitEnd)
writeFileSync(path, text)
