/** Admit quiet speech immediately; suppress only near-digital silence after a short tail. */
export class SilenceGate {
  private audibleUntil = 0
  static readonly floorRms = 4 / 32768
  constructor(private readonly hangoverMs = 160) {}
  reset() { this.audibleUntil = 0 }
  admitRms(rms: number, nowMs: number) {
    if (rms >= SilenceGate.floorRms) this.audibleUntil = nowMs + this.hangoverMs
    return rms >= SilenceGate.floorRms || nowMs < this.audibleUntil
  }
  admit(frame: ArrayLike<number>, nowMs: number) {
    let energy = 0
    for (let i = 0; i < frame.length; i++) energy += frame[i] * frame[i]
    return this.admitRms(Math.sqrt(energy / Math.max(1, frame.length)) / 32768, nowMs)
  }
}
