/** Preflight eligibility only: the capture result must still confirm native exclusion. */
export function supportsSystemAudioExclusion(platform: string, osRelease: string, electronVersion: string): boolean {
  const [electronMajor, electronMinor] = electronVersion.split(".").map(Number)
  // Electron 43.4.0 first forwards restrictOwnAudio to the native loopback device.
  if (!(electronMajor > 43 || (electronMajor === 43 && electronMinor >= 4))) return false
  const [major, , build] = osRelease.split(".").map(Number)
  // Updated Windows 10 2004+ can provide process loopback. Native activation
  // and returned track settings remain authoritative, with video-only failure.
  if (platform === "win32") return major >= 10 && build >= 19041
  // Darwin 22 = macOS 13, which introduced ScreenCaptureKit audio capture.
  if (platform === "darwin") return major >= 22
  return false
}
