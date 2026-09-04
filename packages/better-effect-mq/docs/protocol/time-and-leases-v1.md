# Time and leases v1

Protocol timestamps and durations are integer milliseconds. Timestamps are non-negative safe-integer epoch milliseconds; durations are non-negative safe integers unless an option explicitly requires a positive duration. Every time-sensitive request supplies one coherent `now`, and the adapter must not mix application, database, Redis, and test clocks within an operation. The core does not call `Date.now()` for transitions.

A claim lease has an owner, a non-empty token, and an expiry strictly later than `now`. Settlement, release, and heartbeat require the exact token and reject expiry at `now` or earlier. Tokens fence late workers from changing a newer delivery. Fencing cannot undo an external side effect already performed by a handler.

Heartbeat renews leases using the requested positive duration and reports `renewed` and `lost` entries. Lost leases are not silently renewed. `recoverStalled` may act only once the lease expiry is reached; it never steals a still-valid lease. Recovery increments `stalledCount` with safe-integer saturation and either requeues or terminalizes according to the configured maximum policy.

Worker lease supervision is cooperative. A lost lease aborts the attempt, and a Promise that ignores its signal cannot be forcibly killed. Shutdown may release active jobs; release does not consume handler-attempt budget. Applications must make external effects idempotent.
