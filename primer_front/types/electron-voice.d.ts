export {}

declare global {
  interface Window {
    electronVoice?: {
      connect: (payload: { host: string; port: number; mediaToken: string }) => Promise<unknown>
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
      sendPcm16Frame: (pcm16Base64: string) => Promise<unknown>
      onPcm16Frame: (listener: (pcm16Base64: string) => void) => () => void
      onHotkeyAction: (listener: (payload: { action: "toggle_mute" | "toggle_deafen" | "push_to_talk" }) => void) => () => void
    }
  }
}
