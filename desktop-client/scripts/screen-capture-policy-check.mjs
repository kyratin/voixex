import assert from 'node:assert/strict'
import { supportsSystemAudioExclusion as supported } from '../dist/screen-capture-policy.js'

const cases = [
  ['win32', '10.0.19040', '43.8.7', false],
  ['win32', '10.0.19041', '43.8.7', true],
  ['win32', '10.0.19045', '43.8.7', true],
  ['win32', '10.0.20348', '43.8.7', true],
  ['win32', '10.0.22631', '43.8.7', true],
  ['darwin', '21.6.0', '43.8.7', false],
  ['darwin', '22.0.0', '43.8.7', true],
  ['darwin', '25.1.0', '43.8.7', true],
  ['darwin', '25.1.0', '37.10.3', false],
  ['win32', '10.0.22631', '43.3.0', false],
  ['linux', '6.8.0', '43.8.7', false]
]
for (const [platform, osRelease, electronVersion, expected] of cases) {
  assert.equal(supported(platform, osRelease, electronVersion), expected, `${platform} ${osRelease}, Electron ${electronVersion}`)
}
console.log(`PASS system audio exclusion capability: ${cases.length} OS/runtime boundaries`)
