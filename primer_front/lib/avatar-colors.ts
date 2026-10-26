// Deterministic gradient backgrounds for initials avatars, so the same user
// always gets the same colors across chat, member list and voice rows.
const AVATAR_GRADIENTS = [
  "linear-gradient(135deg, #f472b6 0%, #8b5cf6 100%)",
  "linear-gradient(135deg, #fb923c 0%, #f43f5e 100%)",
  "linear-gradient(135deg, #2dd4bf 0%, #3b82f6 100%)",
  "linear-gradient(135deg, #a78bfa 0%, #6366f1 100%)",
  "linear-gradient(135deg, #facc15 0%, #f97316 100%)",
  "linear-gradient(135deg, #34d399 0%, #0ea5e9 100%)",
  "linear-gradient(135deg, #c084fc 0%, #ec4899 100%)",
  "linear-gradient(135deg, #60a5fa 0%, #818cf8 100%)",
]

function hashSeed(seed: string): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

export function avatarGradient(seed: string): string {
  return AVATAR_GRADIENTS[hashSeed(seed || "?") % AVATAR_GRADIENTS.length]
}
