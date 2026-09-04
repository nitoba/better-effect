# Errors v1

Protocol errors are tagged `better-result` errors and are returned in operation-specific unions. Adapters must preserve the focused error category and must not expose backend exceptions, payloads, SQL, keys, credentials, stacks, or arbitrary causes in safe protocol diagnostics.

## Core categories

- `JobStoreFailure` describes infrastructure failure and includes an operation, a safe message, and `retryable`.
- `JobDefinitionError` describes malformed or unsafe request/persistence data.
- `JobNotFoundError` means the requested Job ID is absent.
- `LeaseLostError` means the token is missing, mismatched, expired, or the lease is absent.
- `InvalidJobTransitionError` means the state does not permit the operation.
- `JobNotRetryableError`, `JobNotCancellableError`, and `JobNotPromotableError` describe failed state preconditions.
- `UnsupportedJobStoreOperationError` means a list/count shape is outside the fixed portable support matrix.
- `JobStoreWakeAbortedError` is the typed abort result for `awaitWake`; the abort reason is not retained.
- `SettlementConflictError` means a settlement replay used the same job and
  lease token as an already-recorded settlement but a different canonical
  outcome. It contains `jobId`, `leaseToken`, and the fixed reason
  `outcome-mismatch`; it is not retryable with that outcome.
- `JobStoreProtocolMismatchError` is raised during store acquisition or Worker
  startup when the descriptor is not an immutable compatible protocol-v1
  descriptor. It contains `expected`/`expectedProtocolVersion`,
  `actual`/`actualProtocolVersion`, and optional bounded `adapter` and
  `adapterVersion` diagnostics. Invalid or unsafe diagnostic values are
  omitted, never copied into the error.

`SettlementConflictError` is distinct from `LeaseLostError`: the former proves
that the token already settled another outcome, while the latter means that the
presented lease is not current. Repeating the exact same canonical outcome with
the same token must return `SettlementResult.status = "already-applied"`; a
different outcome must return `SettlementConflictError` without changing the
job or attempt ledger. A protocol mismatch fails closed before polling or
supervision starts.

Infrastructure failures marked retryable may be retried by the Worker with bounded policy. Lease, state, not-found, validation, and unsupported-operation errors are not infrastructure retries. A store must report ID/token collisions as bounded `JobStoreFailure`, never loop indefinitely.

## Persisted failures

`SerializedJobFailure` contains only `kind`, optional safe `code`, a redacted safe `message`, optional JSON-safe `data`, `retryable`, and integer epoch-millisecond `recordedAt`. The allowed kinds are `typed`, `defect`, `encode`, `timeout`, `decode`, `stalled`, and `cancelled`. A live Error or generic error copier is not part of the wire contract.

Malformed persistence values and unknown fields are rejected. Error handling must preserve the exact program/handler failure where the higher-level Worker contract requires it, while storage-facing diagnostics remain bounded and safe.
