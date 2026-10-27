export {}

type VoixexServerCertificate = {
  v: 1
  certId: string
  serverId: string
  clientId: string
  publicKey: string
  issuedAt: string
  sig: string
}

type VoixexIdentityServerInfo = { label?: string; apiHost?: string; apiPort?: string; apiUseHttps?: boolean; authMode?: string }

type VoixexIdentityMeta = { nick?: string; label?: string; address?: string; secure?: boolean }

export type VoixexStoredIdentity = {
  ref: string
  publicKey: string
  certificate: VoixexServerCertificate | null
  createdAt: string
  meta: VoixexIdentityMeta
}

declare global {
  interface Window {
    /** Desktop window info; customTitleBar = the system title bar is hidden and the UI draws one. */
    voixexWindow?: { platform: string; customTitleBar: boolean }
    /** Per-server device certificates (desktop only). Private keys never leave the main process. */
    voixexIdentity?: {
      create: () => Promise<{ ref: string; publicKey: string }>
      setCertificate: (ref: string, certificate: VoixexServerCertificate) => Promise<void>
      get: (ref: string) => Promise<{ publicKey: string; certificate: VoixexServerCertificate | null } | null>
      sign: (ref: string, message: string) => Promise<string>
      remove: (ref: string) => Promise<void>
      /** Older desktop builds lack list/setMeta. */
      list?: () => Promise<VoixexStoredIdentity[]>
      setMeta?: (ref: string, meta: VoixexIdentityMeta) => Promise<void>
      exportToFile: (ref: string, passphrase: string, server: VoixexIdentityServerInfo) => Promise<string | null>
      pickImportFile: () => Promise<{ path: string; contents: string } | null>
      importFromFile: (
        contents: string,
        passphrase: string
      ) => Promise<{ ref: string; publicKey: string; certificate: VoixexServerCertificate; server: VoixexIdentityServerInfo }>
    }
    electronVoice?: {
      /** macOS 10.15+: triggers system mic permission dialog from the main process (required alongside Info.plist). */
      requestMicrophoneAccess?: () => Promise<{ granted: boolean }>
      /** apiBase: used by the Android app, whose voice goes over WebSocket to the API host. */
      connect: (payload: { host: string; port: number; mediaToken: string; transport?: "udp" | "tcp"; apiBase?: string }) => Promise<unknown>
      joinRoom: (roomId: string) => Promise<unknown>
      leaveRoom: () => Promise<unknown>
      setMute: (muted: boolean) => Promise<unknown>
      setDeafen: (deafened: boolean) => Promise<unknown>
      disconnect: () => Promise<unknown>
      getState: () => Promise<unknown>
      setSelfTestTone: (enabled: boolean) => Promise<unknown>
      getStats: () => Promise<unknown>
      listAudioDevices: () => Promise<Array<{ id: string; label: string; kind: "input" | "output"; isDefault?: boolean }>>
      getAudioDevices: () => Promise<{ inputId: string | null; outputId: string | null }>
      setAudioDevices: (selection: { inputId: string | null; outputId: string | null }) => Promise<unknown>
      getKeybinds: () => Promise<{ toggleMute: string | null; toggleDeafen: string | null; pushToTalk: string | null }>
      setKeybinds: (keybinds: { toggleMute: string | null; toggleDeafen: string | null; pushToTalk: string | null }) => Promise<unknown>
      clearKeybinds: () => Promise<unknown>
      sendPcm16Frame: (pcm16Base64: string) => void
      sendOpusFrame: (opusBase64: string) => void
      sendScreenChunk: (chunkBase64: string) => void
      listScreenSources: () => Promise<Array<{ id: string; name: string }>>
      setScreenSource: (sourceId: string | null) => Promise<unknown>
      onPcm16Frame: (listener: (pcm16Base64: string) => void) => () => void
      onScreenChunk: (listener: (chunkBase64: string) => void) => () => void
      onHotkeyAction: (listener: (payload: { action: "toggle_mute" | "toggle_deafen" | "push_to_talk" }) => void) => () => void
    }
  }
}
