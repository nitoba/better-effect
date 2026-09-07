# Controlled claim protocol v3

This document defines the first distributed-controls extension for
`better-effect-mq`. It is additive to JobStore protocol v1: a v1 queue remains
valid until controls are reconciled for it. Once a queue has enabled controls,
the v1 `claim` operation fails closed with `ControlsRevisionMismatchError`.
There is no legacy bypass.

## Descriptors and revisions

`QueueControls.define(queue, options)` and
`QueueControls.registry({ group, controls })` are immutable descriptors. They
do not open a store or start a worker. A controls implementation is supplied
through a Layer, and `QueueControls.reconcile(registry)` is a yieldable
operation in the current Runtime.

Each queue has one durable record containing `enabled`, a monotonic `revision`,
global and per-key limits, and an optional fixed-window rate limit. An
unchanged reconciliation preserves its revision. A changed configuration or
explicit disable increments it. A controlled claim and controlled lifecycle
operation must present the exact revision; mismatch is an error that requires
refresh/retry.

## Dispatch keys

`dispatchKey` is producer data. It is validated as a non-empty string of at
most 512 characters without NUL or the reserved `__none__` value, and is
persisted separately from payload metadata. Workers never derive it again. Jobs
without a key use the shared `__none__` bucket when per-key concurrency is
enabled; they are not silently unlimited.

## Atomic claim

Controlled claim evaluates pause, due time, global capacity, per-key capacity,
and rate-window capacity in one adapter-owned atomic section. Each successful
claim creates a permit identified by Job ID and lease token. Settlement,
release, and stalled recovery remove only the matching permit. A stale token
cannot release a newer owner’s permit. Active cancellation retains the permit
until the fenced settlement completes.

The Memory adapter is the reference implementation. Active job records are the
capacity source of truth, while lease-token permits provide fencing and
dispatch-key ownership. This also counts jobs claimed by v1 before controls were
enabled; once controls are enabled, v1 claims fail closed.

## Fixed-window rate limit

`{ max, durationMs }` is a fixed window anchored at the first accepted claim.
When the window expires, the next accepted claim starts a new window at the
supplied protocol clock. Settlement, release, retry, and recovery do not refund
rate capacity. A full window returns `nextEligibleAtMs`; boundary bursts are
intentional. Sliding windows and token buckets are future extensions.

## Fairness

The reference adapter scans a bounded rotating candidate set. A full dispatch
key is skipped so other keys can run, and a blocked prefix is not revisited
forever. Priority and run time still order candidates within the rotating
bounded scan. Controlled stalled recovery is scoped to one queue and requires
that queue's revision.
