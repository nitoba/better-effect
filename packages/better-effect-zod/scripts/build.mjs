import { spawnSync } from "node:child_process"

const root = new URL("../", import.meta.url)
const command = process.platform === "win32" ? "npx.cmd" : "npx"
const result = spawnSync(command, ["tsc", "-p", "tsconfig.build.json"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32"
})

process.exit(result.status ?? 1)
