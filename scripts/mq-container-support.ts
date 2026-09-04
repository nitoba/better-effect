// oxlint-disable anti-slop/no-unknown-parameters -- container inspect JSON is an untyped external boundary.
// oxlint-disable anti-slop/no-runtime-typeof -- inspect JSON must be validated before asserting network exposure.
// oxlint-disable anti-slop/no-reflect-get -- inspect JSON property access is intentionally guarded at the boundary.
export type StoppableContainer = { readonly stop: () => Promise<void> }

type DockerPortBinding = { HostIp?: string }
type DockerPortBindings = Record<string, DockerPortBinding[] | undefined>

export const bindPortsToLoopback = (bindings: DockerPortBindings | undefined): void => {
  if (bindings === undefined)
    throw new Error('Testcontainers did not configure database port bindings')
  for (const portBindings of Object.values(bindings))
    for (const binding of portBindings ?? []) binding.HostIp = '127.0.0.1'
}

export const hasOnlyLoopbackBindings = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return false
  const bindings = Object.values(value)
  return (
    bindings.length > 0 &&
    bindings.every(
      (portBindings) =>
        Array.isArray(portBindings) &&
        portBindings.length > 0 &&
        portBindings.every(
          (binding) =>
            typeof binding === 'object' &&
            binding !== null &&
            Reflect.get(binding, 'HostIp') === '127.0.0.1'
        )
    )
  )
}

export class ContainerLifecycle<Container extends StoppableContainer> {
  readonly #containers = new Set<Container>()
  #activeStarts = 0
  #closing = false
  #cleanup: Promise<readonly unknown[]> | undefined
  #startSettled = Promise.resolve()
  #notifyStartSettled: (() => void) | undefined

  constructor(private readonly fallback: () => Promise<readonly unknown[]>) {}

  async start(make: () => Promise<Container>): Promise<Container> {
    if (this.#closing) throw new Error('container cleanup is already in progress')
    this.#activeStarts += 1
    try {
      const container = await make()
      this.#containers.add(container)
      return container
    } finally {
      this.#activeStarts -= 1
      if (this.#activeStarts === 0) this.#notifyStartSettled?.()
    }
  }

  cleanup(): Promise<readonly unknown[]> {
    this.#closing = true
    return (this.#cleanup ??= this.drain())
  }

  private async waitForStarts(): Promise<void> {
    if (this.#activeStarts === 0) return
    this.#startSettled = new Promise<void>((resolve) => {
      this.#notifyStartSettled = resolve
    })
    await this.#startSettled
  }

  private async drain(): Promise<readonly unknown[]> {
    const failures: unknown[] = []
    do {
      await this.waitForStarts()
      const containers = [...this.#containers]
      this.#containers.clear()
      for (const container of containers.reverse()) {
        try {
          await container.stop()
        } catch (cause) {
          failures.push(cause)
        }
      }
    } while (this.#activeStarts > 0 || this.#containers.size > 0)
    failures.push(...(await this.fallback()))
    return failures
  }
}
