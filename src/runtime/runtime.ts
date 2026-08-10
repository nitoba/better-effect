import {
  buildLayer,
  type AnyLayer,
  type BuiltLayer,
  type CompleteLayer,
  type LayerBackend
} from '../layer'

export class Runtime {
  private constructor(private readonly built: BuiltLayer) {}

  static async make<L extends AnyLayer>(
    layer: CompleteLayer<L>,
    backend: LayerBackend
  ): Promise<Runtime> {
    const built = await buildLayer(layer, backend)

    return new Runtime(built)
  }

  static async run<A, L extends AnyLayer>(
    layer: CompleteLayer<L>,
    backend: LayerBackend,
    program: () => A | PromiseLike<A>
  ): Promise<Awaited<A>> {
    const runtime = await Runtime.make(layer, backend)

    try {
      return await runtime.run(program)
    } finally {
      await runtime.dispose()
    }
  }

  run<A>(program: () => A): A {
    return this.built.run(program)
  }

  dispose(): Promise<void> {
    return this.built.dispose()
  }
}
