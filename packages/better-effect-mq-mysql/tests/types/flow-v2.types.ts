import { expectTypeOf } from 'bun:test'
import type { FlowStoreV2, FlowStoreV2Descriptor } from 'better-effect-mq'
import {
  MySqlFlowStore,
  type MySqlFlowStoreInstance,
  type MySqlJobStoreConfig,
  type Pool
} from '../../src'

const pool: Pool = {
  getConnection: async () => {
    throw new Error('type-only pool')
  }
}

expectTypeOf<MySqlFlowStoreInstance>().toMatchTypeOf<FlowStoreV2>()
expectTypeOf<MySqlFlowStoreInstance['descriptor']>().toEqualTypeOf<FlowStoreV2Descriptor>()
expectTypeOf(MySqlFlowStore.make).toMatchTypeOf<
  (config: MySqlJobStoreConfig) => Promise<MySqlFlowStoreInstance>
>()

void pool
