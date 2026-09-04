# Cursors and ordering v1

## Claim order

All adapters must use one total order for claim candidates:

1. `priority` descending;
2. `runAt` ascending;
3. `orderingSequence` ascending;
4. Job ID by unsigned UTF-8 bytes, lexicographically, with a shorter prefix first.

This is not JavaScript UTF-16 order and not locale collation. Identity validation rejects unpaired UTF-16 surrogates, and accepted strings are not trimmed, normalized, or case-folded.

`orderingSequence` is a per-store, non-negative safe-integer sequence. The first
new insertion receives `1`; every requeue or later insertion consumes the next
value. It is never reused, including after a job is removed.

## Listing

`list` is encoded-neutral and supports optional `queue`, `name`, `version`, exact metadata, and one state or a state list. Its order is `enqueuedAt`, `runAt`, or `finishedAt`, ascending or descending, with the persisted ordering sequence and ID as tie-breakers. The result contains jobs and an optional `nextCursor`.

A `JobListCursor` is version 1 and carries the primary ordering value, ordering sequence, ID, ordering, direction, and normalized filter binding. Reusing a cursor with incompatible filters or order is an error. Cursors are keyset cursors: adapters must not reinterpret them as offsets or silently fall back to a full scan.

The portable contract has no arbitrary predicates or provider-specific ordering. Unsupported combinations return `UnsupportedJobStoreOperationError`.
