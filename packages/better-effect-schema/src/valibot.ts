import { Schema as CoreSchema } from './schema.js'
import { ValibotAdapter } from './adapters/valibot/index.js'

/** Preconfigured Valibot-backed schema facade. */
export const Schema = CoreSchema.with(ValibotAdapter)

export namespace Schema {
  export type Codec<
    Input,
    Output,
    Props = Output,
    Encoded = Input,
    EncodeFailure = never
  > = CoreSchema.Codec<Input, Output, Props, Encoded, EncodeFailure>
  export type Input<Schema> = CoreSchema.Input<Schema>
  export type Output<Schema> = CoreSchema.Output<Schema>
  export type Props<Class> = CoreSchema.Props<Class>
  export type Fields<Class> = CoreSchema.Fields<Class>
  export type Struct<Class> = CoreSchema.Struct<Class>
  export type Encoded<Class> = CoreSchema.Encoded<Class>
  export type Instance<Class> = CoreSchema.Instance<Class>
  export type Effect<Value, Failure> = CoreSchema.Effect<Value, Failure>
}

export { ValibotAdapter } from './adapters/valibot/index.js'
export type {
  ValibotAdapterContract,
  ValibotAsyncConfiguredAdapter,
  ValibotAdapterOptions,
  ValibotAsyncEncoder,
  ValibotConfiguredAdapter,
  ValibotEncoder
} from './adapters/valibot/index.js'
