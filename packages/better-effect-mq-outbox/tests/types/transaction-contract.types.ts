import { expectTypeOf } from 'bun:test'

import type {
  OutboxAppendError,
  OutboxAppendResult,
  OutboxAppendStore,
  OutboxOperation,
  OutboxRecordInput,
  OutboxStore
} from '../../src'

// Transaction ownership is adapter-specific; the storage-neutral core must not
// grow a native resource or transaction method.
type CoreStoreTransactionKey = Extract<keyof OutboxStore, 'transaction' | 'transact'>

expectTypeOf<CoreStoreTransactionKey>().toEqualTypeOf<never>()

// The core append contract remains a single prepared record operation. Native
// appendIn helpers belong to adapters as advanced escape hatches.
expectTypeOf<Parameters<OutboxAppendStore['append']>>().toEqualTypeOf<[input: OutboxRecordInput]>()
expectTypeOf<ReturnType<OutboxAppendStore['append']>>().toEqualTypeOf<
  OutboxOperation<OutboxAppendResult, OutboxAppendError>
>()
