import type { WebEffectSuccess } from './types'

const DEFAULT_FAILURE_MESSAGE = 'Internal Server Error'

/** Convert a successful value using the boundary's safe default policy. */
export const defaultSuccess = ({ value }: WebEffectSuccess): Response => {
  if (value instanceof Response) {
    return value
  }

  if (value === undefined) {
    return new Response(null, { status: 204 })
  }

  return Response.json({ data: value })
}

/** Redact typed failures unless the failure is an intentional Response. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Typed Result errors are intentionally opaque at this HTTP boundary.
export const defaultFailure = (error: unknown): Response => {
  if (error instanceof Response) {
    return error
  }

  return Response.json({ error: DEFAULT_FAILURE_MESSAGE }, { status: 500 })
}

/** Validate policy output at the JavaScript boundary before returning it. */
export const assertResponse = (response: Response): Response => {
  if (!(response instanceof Response)) {
    throw new TypeError('WebEffect response policies must return a Response')
  }

  return response
}
