import type { CapacitorConfig } from "@capacitor/cli"

/** Android app: the static UI export (out/) in a WebView, see lib/mobile-bridge.ts. */
const config: CapacitorConfig = {
  appId: "com.kyratin.voixex",
  appName: "Voixex",
  webDir: "out",
  server: {
    androidScheme: "https",
    // Self-hosted servers may run plain http (the UI warns about it).
    cleartext: true
  },
  android: {
    allowMixedContent: true,
    backgroundColor: "#0f0f14"
  }
}

export default config
