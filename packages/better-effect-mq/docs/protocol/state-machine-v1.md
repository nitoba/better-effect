# State machine v1

The only protocol v1 job states are `waiting`, `delayed`, `active`, `completed`, `failed`, and `cancelled`.

```text
waiting or due delayed --claim--> active
active --complete--> completed
active --retry--> waiting or delayed
active --fail--> failed
active --cancelled--> cancelled
active --release--> waiting
expired active --recoverStalled--> waiting or failed/cancelled
failed or cancelled --admin retry--> waiting or delayed
waiting or delayed --cancel--> cancelled
delayed --promote--> waiting
```

A delayed job is claimable only when `runAt <= now`. `promote` is the separate administrative override: it sets `runAt` to `now`, does not claim the job, and does not change attempt or delivery counters. Terminal states never silently revive; explicit retry is required.

Every active exit except recovery requires the exact current lease token and `now < leaseExpiresAt`. Missing, mismatched, or expired leases return `LeaseLostError` without changing the snapshot. Claim requires a non-empty worker ID and lease token and an expiry strictly later than `now`.

Active cancellation is cooperative. `requestCancellation` records a request without stealing the lease. The next settlement, release, or stalled recovery becomes terminal `cancelled`, regardless of the handler's proposed outcome. A waiting or delayed job can be cancelled directly.

`attemptsMade` counts handler executions that settle; `deliveryCount` counts successful claims, including redeliveries; `stalledCount` counts expired-lease recoveries. `attemptsMade <= deliveryCount`; release and stalled recovery do not consume handler-attempt budget. The ledger separately records `completed`, `retried`, `failed`, `cancelled`, `stalled`, and `released` outcomes.

The reducer is pure and immutable. The adapter owns the atomic persistence of the returned record and optional attempt record. Future states require a new protocol version.
