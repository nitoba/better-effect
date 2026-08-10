import { AnyTaggedError, matchErrorPartial, Result, type Result as ResultType } from 'better-result'

import type { CreateTodoInput, LoginInput, UpdateTodoInput } from './domain'
import { InvalidRequest, Unauthorized } from './errors'
import { AuthService } from './services/auth-service'

export const isLoginInput = (value: unknown): value is LoginInput => {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const input = value as Record<string, unknown>

  return (
    typeof input.email === 'string' &&
    input.email.length > 0 &&
    typeof input.password === 'string' &&
    input.password.length > 0
  )
}

export const isCreateTodoInput = (value: unknown): value is CreateTodoInput => {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const input = value as Record<string, unknown>

  return typeof input.title === 'string' && input.title.trim().length > 0
}

export const isUpdateTodoInput = (value: unknown): value is UpdateTodoInput => {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const input = value as Record<string, unknown>

  const hasTitle = 'title' in input

  const hasCompleted = 'completed' in input

  if (!hasTitle && !hasCompleted) {
    return false
  }

  if (hasTitle && (typeof input.title !== 'string' || input.title.trim().length === 0)) {
    return false
  }

  if (hasCompleted && typeof input.completed !== 'boolean') {
    return false
  }

  return true
}

export const readJson = async <T>(
  request: Request,
  validate: (value: unknown) => value is T
): Promise<ResultType<T, InvalidRequest>> => {
  const parsed = await Result.tryPromise({
    try: () => request.json(),

    catch: () =>
      new InvalidRequest({
        message: 'Invalid JSON body'
      })
  })

  return parsed.andThen((value) =>
    validate(value)
      ? Result.ok(value)
      : Result.err(
          new InvalidRequest({
            message: 'Invalid request body'
          })
        )
  )
}

const bearerToken = (request: Request): string | null => {
  const authorization = request.headers.get('authorization')

  if (!authorization?.startsWith('Bearer ')) {
    return null
  }

  const token = authorization.slice('Bearer '.length).trim()

  return token.length > 0 ? token : null
}

export const requireUser = (request: Request) =>
  Result.gen(async function* () {
    const token = bearerToken(request)

    if (!token) {
      return Result.err(
        new Unauthorized({
          message: 'Missing bearer token'
        })
      )
    }

    const auth = yield* AuthService

    const authenticated = yield* Result.await(auth.authenticate(token))

    return Result.ok(authenticated)
  })

const errorResponse = (status: number, code: string, message: string) =>
  Response.json(
    {
      error: {
        code,
        message
      }
    },
    {
      status
    }
  )

export const toResponse = <A, E>(result: ResultType<A, E>, status = 200): Response => {
  if (Result.isOk(result)) {
    return Response.json(result.value, {
      status
    })
  }

  const error = result.error as AnyTaggedError

  const toResponseError = matchErrorPartial(
    error,
    {
      InvalidRequest: (error) => errorResponse(400, error._tag, error.message),
      InvalidCredentials: (error) => errorResponse(401, error._tag, error.message),
      Unauthorized: (error) => errorResponse(401, error._tag, error.message),
      TodoNotFound: (error) => errorResponse(404, error._tag, error.message),
      DatabaseFailure: (error) => errorResponse(500, error._tag, 'Internal server error'),
      PasswordFailure: (error) => errorResponse(500, error._tag, 'Internal server error')
    },
    () => errorResponse(500, 'InternalServerError', 'Internal server error')
  )

  return toResponseError
}

export const toEmptyResponse = <E>(result: ResultType<void, E>, status = 204): Response => {
  if (Result.isOk(result)) {
    return new Response(null, {
      status
    })
  }

  return toResponse(result)
}
