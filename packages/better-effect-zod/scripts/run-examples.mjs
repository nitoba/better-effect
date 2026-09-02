import { readdir } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

const root = fileURLToPath(new URL("../", import.meta.url))
const directory = join(root, ".examples-dist")
const examples = (await readdir(directory))
  .filter((name) => name.endsWith(".js"))
  .sort()

for (const example of examples) {
  const result = spawnSync(process.execPath, [join(directory, example)], {
    cwd: root,
    stdio: "inherit"
  })

  if (result.status !== 0) process.exit(result.status ?? 1)
}
