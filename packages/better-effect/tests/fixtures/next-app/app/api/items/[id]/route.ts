import { Result } from 'better-result'

import { Layer, Service } from 'better-effect'
import { NextEffect } from 'better-effect/next'

class ItemService extends Service<ItemService>()('NextFixtureItemService') {
  read(id: string): string {
    return `${id}:fixture`
  }
}

const http = NextEffect.managed(Layer.make(ItemService))

const getItem = http.gen(
  async function* (_request, context: RouteContext<'/api/items/[id]'>) {
    const { id } = await context.params
    const item = yield* ItemService

    return Result.ok({ value: item.read(id) })
  },
  {
    serialize: (value) => value
  }
)

export const GET = getItem
export const POST = getItem
