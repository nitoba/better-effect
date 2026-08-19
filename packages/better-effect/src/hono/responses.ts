import type { HonoContext, HonoEffectSuccess } from './types'

export const defaultSuccess = (
  { value, status, serialize }: HonoEffectSuccess,
  context: HonoContext
): Response => {
  if (value instanceof Response) {
    return value
  }

  const body = serialize === undefined ? value : serialize(value)

  if (body === undefined) {
    // SAFETY: route status is intentionally configurable and Hono validates it at response construction.
    return context.body(null, (status ?? 204) as never)
  }

  if (status === undefined) {
    return context.json({ data: body })
  }

  // SAFETY: route status is intentionally configurable and Hono validates it at response construction.
  return context.json({ data: body }, status as never)
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Result errors are intentionally opaque at this HTTP boundary.
export const defaultFailure = (error: unknown, context: HonoContext): Response => {
  if (error instanceof Response) {
    return error
  }

  const message = error instanceof Error ? error.message : String(error)

  return context.json({ error: message }, 500)
}
