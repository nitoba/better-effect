import {
  matchErrorPartial,
  Result,
  type AnyTaggedError,
  type Result as ResultType
} from 'better-result'

import type { CreateTodoInput, LoginInput, UpdateTodoInput } from './domain'
import { Effect } from './better-effect'
import { InvalidRequest, Unauthorized } from './errors'
import { AuthService } from './services/auth-service'

type JsonPrimitive = string | number | boolean | null

interface JsonObject {
  readonly [key: string]: JsonValue
}

type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[]

const isJsonValue = <Value>(value: Value): value is Value & JsonValue => {
  const tag = Object.prototype.toString.call(value)

  if (
    tag === '[object String]' ||
    tag === '[object Number]' ||
    tag === '[object Boolean]' ||
    tag === '[object Null]'
  ) {
    return true
  }

  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item))
  }

  if (tag !== '[object Object]') {
    return false
  }

  return Object.values(Object(value)).every((item) => isJsonValue(item))
}

const isJsonObject = (value: JsonValue): value is JsonObject =>
  value !== null && !Array.isArray(value) && Object(value) === value

const isStringValue = (value: JsonValue | undefined): value is string =>
  Object.prototype.toString.call(value) === '[object String]'

const isBooleanValue = (value: JsonValue | undefined): value is boolean =>
  value === true || value === false

export const isLoginInput = (value: JsonValue): value is LoginInput => {
  if (!isJsonObject(value)) {
    return false
  }

  return (
    isStringValue(value.email) &&
    value.email.length > 0 &&
    isStringValue(value.password) &&
    value.password.length > 0
  )
}

export const isCreateTodoInput = (value: JsonValue): value is CreateTodoInput => {
  if (!isJsonObject(value)) {
    return false
  }

  return isStringValue(value.title) && value.title.trim().length > 0
}

export const isUpdateTodoInput = (value: JsonValue): value is UpdateTodoInput => {
  if (!isJsonObject(value)) {
    return false
  }

  const hasTitle = 'title' in value

  const hasCompleted = 'completed' in value

  if (!hasTitle && !hasCompleted) {
    return false
  }

  if (hasTitle && (!isStringValue(value.title) || value.title.trim().length === 0)) {
    return false
  }

  if (hasCompleted && !isBooleanValue(value.completed)) {
    return false
  }

  return true
}

export const readJson = async <T extends JsonValue>(
  request: Request,
  validate: (value: JsonValue) => value is T
): Promise<ResultType<T, InvalidRequest>> => {
  const parsed = await Result.tryPromise({
    try: async () => {
      const value = await request.json()

      if (!isJsonValue(value)) {
        throw new Error('Invalid JSON value')
      }

      return value
    },

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
  Effect.gen(async function* () {
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

  // SAFETY: All application errors passed to this response boundary are better-result tagged errors.
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
