import { expectTypeOf } from 'bun:test'

import type {
  OutboxAppendError,
  OutboxAppendResult,
  OutboxAppendStore,
  OutboxOperation,
  OutboxRecordInput,
  OutboxStore
} from '../../src'

type StoreTransactionKey = Extract<keyof OutboxStore, 'transaction' | 'transact'>

expectTypeOf<StoreTransactionKey>().toEqualTypeOf<never>()
expectTypeOf<Parameters<OutboxAppendStore['append']>>().toEqualTypeOf<[input: OutboxRecordInput]>()
expectTypeOf<ReturnType<OutboxAppendStore['append']>>().toEqualTypeOf<
  OutboxOperation<OutboxAppendResult, OutboxAppendError>
>()
