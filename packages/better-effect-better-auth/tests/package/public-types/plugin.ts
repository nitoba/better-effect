import type { BetterAuthPlugin } from 'better-auth'
import { createAuthEndpoint } from 'better-auth/api'

export const releaseGatePlugin = () =>
  ({
    id: 'release-gate',
    endpoints: {
      releaseGate: createAuthEndpoint('/release-gate', { method: 'GET' }, async (context) =>
        context.json({
          ok: true as const
        })
      )
    },
    schema: {
      session: {
        fields: {
          tenantId: {
            required: false,
            type: 'string'
          }
        }
      },
      user: {
        fields: {
          plan: {
            required: false,
            type: 'string'
          }
        }
      }
    },
    $ERROR_CODES: {
      CUSTOM_PLUGIN_FAILURE: {
        code: 'CUSTOM_PLUGIN_FAILURE',
        message: 'The release-gate plugin failed'
      }
    }
  }) satisfies BetterAuthPlugin
