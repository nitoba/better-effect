# Schedule domain

This directory contains the storage-neutral schedule definition contract.
`JobSchedules.schedule` creates an inert immutable draft and
`JobSchedules.define` assigns it to an immutable non-empty group. Definitions
do not start timers, touch a store, or persist payloads.

The default misfire policy is `run-once`, which collapses downtime into one
deterministic occurrence. The default overlap policy is `allow`; callers that
want a schedule to wait for a prior occurrence must set `overlap: 'skip'`.

Cron uses exactly five fields (`minute hour day-of-month month day-of-week`)
and UTC when no timezone is supplied. Timezone conversion is wall-clock based:
nonexistent spring-forward minutes are skipped, while an ambiguous
fall-back minute fires only at its earlier UTC instant. `everyMs` uses its
first slot as the grade anchor, so calculating later occurrences does not
re-anchor a cadence after a redeploy.

Reconcile declarations inside an Effect program. The Job's associated store
selects the matching `JobScheduleStore`; extra `stores` entries let an empty
registry still reach a store so the last removed schedule can be detected.

```ts
const report =
  yield *
  JobSchedules.reconcile(BillingSchedules, {
    removal: 'warn'
  })
```

`removal: 'group'` removes only undeclared records in the definition's group.
Set `removeAfterMs` for a Clock-driven rolling-deploy grace window. The
operation remains Scope-owned and cancellation leaves the records in place.

Schedulers are Layer-first Services. A scheduler resolves the configured
schedule stores, optionally reconciles at startup, sweeps due records in
batches, and delegates compare-and-set ticking to the store:

```ts
const BillingScheduler = JobScheduler.service('@billing/Scheduler')
const BillingSchedulerLive = BillingScheduler.layer(() => ({
  registries: [BillingSchedules],
  startupReconcile: true,
  sweepIntervalMs: 1_000,
  batchSize: 100
}))
```

The Layer owns only the scheduler lifecycle. Runtime shutdown quiesces new
sweeps, drains admitted ticks, and releases the supervisor before its stores.
