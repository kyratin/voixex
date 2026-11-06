const { spawnSync } = require('node:child_process')
const { existsSync, mkdirSync, copyFileSync, readFileSync } = require('node:fs')
const { resolve, join } = require('node:path')

const root = resolve(__dirname, '../native/screen-audio')
function build() {
  if (process.platform !== 'win32') throw new Error('Build native screen audio on Windows with Visual Studio C++ tools and a recent Windows SDK.')
  for (const args of [
    ['-S', root, '-B', join(root, 'build'), '-A', 'x64'],
    ['--build', join(root, 'build'), '--config', 'Release']
  ]) {
    const result = spawnSync('cmake', args, { stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`Native screen audio build failed (${result.status})`)
  }
  mkdirSync(join(root, 'bin'), { recursive: true })
  copyFileSync(join(root, 'build/Release/voixex-screen-audio.exe'), join(root, 'bin/voixex-screen-audio.exe'))
}

// electron-builder hook: Windows packages must always contain the helper.
module.exports = async context => {
  if (context.electronPlatformName !== 'win32') return
  // electron-builder Arch.x64 = 1. Do not ship an x64 helper in an ARM/ia32 app.
  if (context.arch !== 1) throw new Error('Native screen audio currently requires the Windows x64 target')
  if (process.platform === 'win32') build()
  const binary = join(root, 'bin/voixex-screen-audio.exe')
  if (!existsSync(binary)) throw new Error('Windows packaging requires native/screen-audio/bin/voixex-screen-audio.exe. Run npm run build:screen-audio on Windows first and copy the helper when cross-packaging.')
  const bytes = readFileSync(binary)
  const pe = bytes.length >= 64 ? bytes.readUInt32LE(60) : 0
  if (!pe || pe + 6 > bytes.length || bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== 0x8664)
    throw new Error('Native screen audio helper must be a Windows x64 PE executable')
}
if (require.main === module) build()
