import * as z from "zod"
import { Schema } from "better-effect-zod"

type CategoryEncoded = {
  readonly name: string
  readonly children: readonly CategoryEncoded[]
}

const Children = z.lazy(
  () => z.array(Category)
) as z.ZodType<readonly Category[], readonly CategoryEncoded[]>

class Category extends Schema.Class<Category>("examples/Category")({
  name: z.string(),
  children: Children
}) {
  get descendantCount(): number {
    return this.children.reduce(
      (total, child) => total + 1 + child.descendantCount,
      0
    )
  }
}

const root = Category.parse({
  name: "root",
  children: [{
    name: "child",
    children: []
  }]
})

if (!(root.children[0] instanceof Category)) {
  throw new Error("recursive child was not decoded as Category")
}
if (root.descendantCount !== 1) {
  throw new Error("recursive class behavior is unavailable")
}

const encoded: CategoryEncoded = Category.encode(root)
if (encoded.children[0]?.name !== "child") {
  throw new Error("recursive class did not encode")
}

console.log("recursive: ok")
