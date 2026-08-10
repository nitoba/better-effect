import { ServiceRuntime } from '../service/runtime'

import type { LayerBackend } from './backend'
import type { Layer } from './layer'

export interface BuiltLayer {
  dispose(): Promise<void>
}

export const buildLayer = async (layer: Layer, backend: LayerBackend): Promise<BuiltLayer> => {
  for (const provider of layer.providers) {
    await backend.register(provider)
  }

  ServiceRuntime.configure(backend)

  return {
    async dispose() {
      try {
        await backend.disposeAll()
      } finally {
        ServiceRuntime.reset()
      }
    }
  }
}

export class RuntimeLayer {
  static build = buildLayer
}
