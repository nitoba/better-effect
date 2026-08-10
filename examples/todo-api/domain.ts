export type User = {
  readonly id: string
  readonly email: string
  readonly passwordHash: string
  readonly createdAt: string
}

export type PublicUser = {
  readonly id: string
  readonly email: string
}

export type Session = {
  readonly token: string
  readonly userId: string
  readonly expiresAt: string
}

export type Todo = {
  readonly id: string
  readonly userId: string
  readonly title: string
  readonly completed: boolean
  readonly createdAt: string
  readonly updatedAt: string
}

export type LoginInput = {
  readonly email: string
  readonly password: string
}

export type LoginOutput = {
  readonly token: string
  readonly expiresAt: string
  readonly user: PublicUser
}

export type CreateTodoInput = {
  readonly title: string
}

export type UpdateTodoInput = {
  readonly title?: string
  readonly completed?: boolean
}
