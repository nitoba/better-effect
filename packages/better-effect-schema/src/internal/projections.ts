import * as z from "zod"

const encodedProjections = new WeakMap<object, z.ZodType>()
const propsProjections = new WeakMap<object, z.ZodType>()

/** Returns the pure encoded-side projection introduced by Zod 4.5. */
export const getEncodedProjection = <Schema extends z.ZodType>(
  schema: Schema
): z.ZodType<z.input<Schema>, z.input<Schema>> => {
  const cached = encodedProjections.get(schema)
  if (cached !== undefined) {
    return cached as z.ZodType<z.input<Schema>, z.input<Schema>>
  }

  const projection = z.input(schema)
  encodedProjections.set(schema, projection)
  return projection
}

/** Returns the pure decoded/output-side projection introduced by Zod 4.5. */
export const getPropsProjection = <Schema extends z.ZodType>(
  schema: Schema
): z.ZodType<z.output<Schema>, z.output<Schema>> => {
  const cached = propsProjections.get(schema)
  if (cached !== undefined) {
    return cached as z.ZodType<z.output<Schema>, z.output<Schema>>
  }

  const projection = z.output(schema)
  propsProjections.set(schema, projection)
  return projection
}
