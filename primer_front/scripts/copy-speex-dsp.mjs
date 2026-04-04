import { cpSync, existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const dist = resolve(root, "node_modules/@sapphi-red/web-noise-suppressor/dist")
const pub = resolve(root, "public")

if (!existsSync(dist)) {
  console.warn("[copy-speex-dsp] package not installed, skip")
  process.exit(0)
}

cpSync(resolve(dist, "speex.wasm"), resolve(pub, "speex.wasm"))
cpSync(resolve(dist, "speex/workletProcessor.js"), resolve(pub, "speex-worklet.js"))
console.log("[copy-speex-dsp] copied speex.wasm and speex-worklet.js to public/")
