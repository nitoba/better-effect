import type { AnyServiceToken, ServiceResolver } from '../../src/service'

export class TestServiceResolver implements ServiceResolver {
  readonly calls: AnyServiceToken[] = []

  private readonly services = new Map<AnyServiceToken, unknown>()

  provide<T extends AnyServiceToken>(token: T, instance: InstanceType<T>): this {
    this.services.set(token, instance)

    return this
  }

  resolve<T extends AnyServiceToken>(token: T): InstanceType<T> {
    this.calls.push(token)

    if (!this.services.has(token)) {
      throw new Error(`Missing service: ${token.name}`)
    }

    return this.services.get(token) as InstanceType<T>
  }
}
