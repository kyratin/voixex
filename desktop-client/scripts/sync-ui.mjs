import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"

const desktopRoot = resolve(import.meta.dirname, "..")
const frontendRoot = resolve(desktopRoot, "..", "primer_front")
const frontendOut = resolve(frontendRoot, "out")
const desktopUi = resolve(desktopRoot, "ui")

const build = spawnSync("npm", ["run", "build"], {
  cwd: frontendRoot,
  stdio: "inherit",
  shell: process.platform === "win32"
})
if (build.status !== 0) {
  process.exit(build.status ?? 1)
}

if (!existsSync(frontendOut)) {
  console.error(`frontend export folder not found: ${frontendOut}`)
  process.exit(1)
}

rmSync(desktopUi, { recursive: true, force: true })
mkdirSync(desktopUi, { recursive: true })
cpSync(frontendOut, desktopUi, { recursive: true })
console.log(`Copied exported UI to ${desktopUi}`)
