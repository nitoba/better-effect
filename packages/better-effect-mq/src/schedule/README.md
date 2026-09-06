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
