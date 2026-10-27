import { createHmac, randomBytes } from "node:crypto"

type Payload = {
  sub: string
  serverId: string
  clientId: string
  displayName?: string
  mediaSeed?: string
  /** Device certificate the session was opened with; checked against revocation on every request. */
  certId?: string
  exp: number
}

function b64url(input: Buffer | string): string {
  const value = Buffer.isBuffer(input) ? input.toString("base64") : Buffer.from(input).toString("base64")
  return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

function unb64url(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/")
  const pad = normalized.length % 4
  const padded = pad ? normalized + "=".repeat(4 - pad) : normalized
  return Buffer.from(padded, "base64")
}

export function signToken(payload: Payload, secret: string): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = b64url(JSON.stringify(payload))
  const sig = createHmac("sha256", secret).update(`${header}.${body}`).digest()
  return `${header}.${body}.${b64url(sig)}`
}

export function verifyToken(token: string, secret: string): Payload | null {
  const parts = token.split(".")
  if (parts.length !== 3) return null
  const [header, body, signature] = parts
  const expected = b64url(createHmac("sha256", secret).update(`${header}.${body}`).digest())
  if (expected !== signature) return null
  const payload = JSON.parse(unb64url(body).toString()) as Payload
  if (Date.now() / 1000 > payload.exp) return null
  return payload
}

export function makeAuthToken(input: Omit<Payload, "sub" | "exp">, secret: string): string {
  return signToken(
    {
      sub: "auth",
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 12,
      ...input
    },
    secret
  )
}

export function makeMediaToken(input: Omit<Payload, "sub" | "exp">, secret: string): string {
  return signToken(
    {
      sub: "media",
      exp: Math.floor(Date.now() / 1000) + 60 * 30,
      mediaSeed: input.mediaSeed ?? randomBytes(32).toString("base64"),
      ...input
    },
    secret
  )
}
