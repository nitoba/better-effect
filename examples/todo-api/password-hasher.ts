import { Result, type Result as ResultType } from 'better-result'

import { Service } from './better-effect'
import { PasswordFailure } from './errors'

export class PasswordHasher extends Service<PasswordHasher>() {
  hash(password: string): Promise<ResultType<string, PasswordFailure>> {
    return Result.tryPromise({
      try: () => Bun.password.hash(password),
      catch: (cause) =>
        new PasswordFailure({
          cause,
          message: 'Failed to hash password'
        })
    })
  }

  verify(password: string, hash: string): Promise<ResultType<boolean, PasswordFailure>> {
    return Result.tryPromise({
      try: () => Bun.password.verify(password, hash),
      catch: (cause) =>
        new PasswordFailure({
          cause,
          message: 'Failed to verify password'
        })
    })
  }
}
