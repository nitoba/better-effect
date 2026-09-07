import * as z from "zod"
import { Result } from "better-result"
import { Schema } from "better-effect-schema"
import { ZodAdapter } from "better-effect-schema/zod"

const local = Schema.with(ZodAdapter)

type CategoryNode = {
  readonly name: string
  readonly children: readonly CategoryNode[]
}

const categoryNode: z.ZodType<CategoryNode> = z.lazy(() => z.object({
  name: z.string(),
  children: z.array(categoryNode)
}))

class Category extends local.Class<Category>("examples/Category")({
  name: z.string(),
  children: z.array(categoryNode)
}) {
  get descendantCount(): number {
    const count = (node: CategoryNode): number =>
      node.children.reduce((total, child) => total + 1 + count(child), 0)
    return count(this)
  }
}

const decoded = Schema.decode(Category, {
  name: "root",
  children: [{ name: "child", children: [] }]
})
if (Result.isError(decoded)) throw decoded.error
const root = decoded.value

if (!(root instanceof Category)) throw new Error("recursive class did not construct")
if (root.descendantCount !== 1) throw new Error("recursive child count is incorrect")

const projected = Schema.decodeUnknown(Category.encodedSchema, {
  name: "root",
  children: [{ name: "child", children: [] }]
})
if (
  Result.isError(projected) ||
  (projected.value as CategoryNode).children[0]?.name !== "child"
) {
  throw new Error("recursive projection failed")
}

console.log("recursive: ok")
