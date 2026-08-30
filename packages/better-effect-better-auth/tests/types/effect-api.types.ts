import { expectTypeOf } from 'bun:test'
import { betterAuth, type BetterAuthPlugin } from 'better-auth'
import { createAuthEndpoint } from 'better-auth/api'
import { admin } from 'better-auth/plugins'
import type { UnhandledException } from 'better-result'

import type {
  BetterAuthApiError,
  BetterAuthEffectApi,
  BetterAuthEndpointResult,
  BetterAuthErrorCode,
  BetterAuthOperation
} from '../../src'

type Assert<T extends true> = T
type IsAssignable<From, To> = [From] extends [To] ? true : false
type IsNotAssignable<From, To> = IsAssignable<From, To> extends true ? false : true

type CustomEndpoint = {
  (context?: {
    readonly query?: {
      readonly value?: string
    }
    readonly asResponse?: boolean
    readonly returnHeaders?: boolean
    readonly returnStatus?: boolean
  }): Promise<{
    readonly custom: true
  }>
  readonly path: '/custom'
  readonly options: {
    readonly method: 'GET'
  }
}

type CustomApi = {
  readonly customEndpoint: CustomEndpoint
  readonly metadata: {
    readonly version: 1
  }
}

const customPlugin = () =>
  ({
    id: 'custom-effect-plugin',
    endpoints: {
      getCustomProfile: createAuthEndpoint(
        '/custom-effect-plugin/profile',
        {
          method: 'GET'
        },
        async (context) =>
          context.json({
            custom: true as const
          })
      )
    },
    schema: {
      user: {
        fields: {
          age: {
            type: 'number',
            required: false
          }
        }
      },
      session: {
        fields: {
          tenantId: {
            type: 'string',
            required: false
          }
        }
      }
    },
    $ERROR_CODES: {
      CUSTOM_PLUGIN_FAILURE: {
        code: 'CUSTOM_PLUGIN_FAILURE',
        message: 'Custom plugin failure'
      }
    }
  }) satisfies BetterAuthPlugin

const authWithAdmin = betterAuth({
  emailAndPassword: {
    enabled: true
  },
  plugins: [admin()]
})
const authWithoutAdmin = betterAuth({})
const authWithCustomPlugin = betterAuth({
  plugins: [customPlugin()]
})

type Auth = typeof authWithAdmin
type Session = Auth['$Infer']['Session']
type Code = BetterAuthErrorCode<Auth>
type Failure = BetterAuthApiError<Code> | UnhandledException
type PlainAuth = typeof authWithoutAdmin
type PlainCode = BetterAuthErrorCode<PlainAuth>
type CustomPluginAuth = typeof authWithCustomPlugin
type CustomPluginSession = CustomPluginAuth['$Infer']['Session']
type CustomPluginCode = BetterAuthErrorCode<CustomPluginAuth>
type CustomPluginFailure = BetterAuthApiError<CustomPluginCode> | UnhandledException

declare const api: BetterAuthEffectApi<Auth['api'], Code>
declare const plainApi: BetterAuthEffectApi<PlainAuth['api'], PlainCode>
declare const customPluginApi: BetterAuthEffectApi<CustomPluginAuth['api'], CustomPluginCode>
declare const customApi: BetterAuthEffectApi<CustomApi, 'CUSTOM_ERROR'>

const headers = new Headers()
const session = api.getSession({ headers })
const sessionResponse = api.getSession.asResponse({ headers })
const sessionWithHeaders = api.getSession.withHeaders({ headers })
const signIn = api.signInEmail({
  body: {
    email: 'user@example.com',
    password: 'correct horse battery staple'
  }
})
const users = api.listUsers({
  query: {
    limit: 20
  }
})
const pluginProfile = customPluginApi.getCustomProfile()
const custom = customApi.customEndpoint()
const customResponse = customApi.customEndpoint.asResponse()
const customWithHeaders = customApi.customEndpoint.withHeaders({
  query: {
    value: 'test'
  }
})

expectTypeOf(session).toEqualTypeOf<BetterAuthOperation<Session | null, Failure>>()
expectTypeOf(sessionResponse).toEqualTypeOf<BetterAuthOperation<Response, Failure>>()
expectTypeOf(sessionWithHeaders).toEqualTypeOf<
  BetterAuthOperation<
    {
      readonly headers: Headers
      readonly response: Session | null
    },
    Failure
  >
>()
expectTypeOf(signIn).toEqualTypeOf<
  BetterAuthOperation<BetterAuthEndpointResult<Auth['api']['signInEmail']>, Failure>
>()
expectTypeOf(users).toEqualTypeOf<
  BetterAuthOperation<BetterAuthEndpointResult<Auth['api']['listUsers']>, Failure>
>()
expectTypeOf(pluginProfile).toEqualTypeOf<
  BetterAuthOperation<
    BetterAuthEndpointResult<CustomPluginAuth['api']['getCustomProfile']>,
    CustomPluginFailure
  >
>()
expectTypeOf(custom).toEqualTypeOf<
  BetterAuthOperation<
    { readonly custom: true },
    BetterAuthApiError<'CUSTOM_ERROR'> | UnhandledException
  >
>()
expectTypeOf(customResponse).toEqualTypeOf<
  BetterAuthOperation<Response, BetterAuthApiError<'CUSTOM_ERROR'> | UnhandledException>
>()
expectTypeOf(customWithHeaders).toEqualTypeOf<
  BetterAuthOperation<
    {
      readonly headers: Headers
      readonly response: {
        readonly custom: true
      }
    },
    BetterAuthApiError<'CUSTOM_ERROR'> | UnhandledException
  >
>()

type SessionInput = NonNullable<Parameters<typeof api.getSession>[0]>
type CustomInput = NonNullable<Parameters<typeof customApi.customEndpoint>[0]>
type _SessionHidesAsResponse = Assert<IsNotAssignable<'asResponse', keyof SessionInput>>
type _SessionHidesReturnHeaders = Assert<IsNotAssignable<'returnHeaders', keyof SessionInput>>
type _SessionHidesReturnStatus = Assert<IsNotAssignable<'returnStatus', keyof SessionInput>>
type _CustomHidesAsResponse = Assert<IsNotAssignable<'asResponse', keyof CustomInput>>
type _CustomHidesReturnHeaders = Assert<IsNotAssignable<'returnHeaders', keyof CustomInput>>
type _CustomHidesReturnStatus = Assert<IsNotAssignable<'returnStatus', keyof CustomInput>>
type _AdminEndpointIsPresent = Assert<IsAssignable<'listUsers', keyof typeof api>>
type _AdminEndpointIsAbsentWithoutPlugin = Assert<
  IsNotAssignable<'listUsers', keyof typeof plainApi>
>
type _CustomPluginEndpointIsPresent = Assert<
  IsAssignable<'getCustomProfile', keyof typeof customPluginApi>
>
type _CustomPluginUserFieldIsInferred = Assert<
  IsAssignable<'age', keyof CustomPluginSession['user']>
>
type _CustomPluginSessionFieldIsInferred = Assert<
  IsAssignable<'tenantId', keyof CustomPluginSession['session']>
>
type _CustomPluginErrorCodeIsInferred = Assert<
  IsAssignable<'CUSTOM_PLUGIN_FAILURE', CustomPluginCode>
>
type _NonFunctionMemberIsAbsent = Assert<IsNotAssignable<'metadata', keyof typeof customApi>>

// @ts-expect-error transport selection is expressed by `.asResponse`
api.getSession({ headers, asResponse: true })
// @ts-expect-error transport selection is expressed by `.withHeaders`
api.getSession.withHeaders({ headers, returnHeaders: true })
// @ts-expect-error status transport remains available only through `auth.raw`
customApi.customEndpoint({ returnStatus: true })
// @ts-expect-error non-function API metadata is not an effectful endpoint
customApi.metadata
