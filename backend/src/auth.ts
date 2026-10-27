import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from "node:crypto"
import type Database from "better-sqlite3"

/**
 * Member authentication. The shared server password is needed once, to create (or protect) a
 * profile; after that the member signs in at the protection level they chose (AuthMode).
 * A device certificate is an Ed25519 key the server signed for that member.
 */

/**
 * password             — nick + personal password, from any device
 * certificate          — this device's certificate alone
 * password_certificate — certificate + nick + personal password
 */
export type AuthMode = "password" | "certificate" | "password_certificate"

export const AUTH_MODES: readonly AuthMode[] = ["password", "certificate", "password_certificate"]

export function isAuthMode(value: unknown): value is AuthMode {
  return typeof value === "string" && (AUTH_MODES as readonly string[]).includes(value)
}

export function modeNeedsPassword(mode: AuthMode) {
  return mode !== "certificate"
}

export function modeNeedsCertificate(mode: AuthMode) {
  return mode !== "password"
}

/** 1 password, 2 certificate, 3 both; 0 is an unprotected (server-password-only) profile. */
export function authLevel(mode: AuthMode | null) {
  return mode === "password" ? 1 : mode === "certificate" ? 2 : mode === "password_certificate" ? 3 : 0
}

// DER prefix of an Ed25519 SubjectPublicKeyInfo; followed by the raw 32-byte key.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex")

export type Certificate = {
  v: 1
  certId: string
  serverId: string
  clientId: string
  /** Raw Ed25519 public key, base64. */
  publicKey: string
  issuedAt: string
  /** Server's Ed25519 signature over certificateSigningInput(), base64. */
  sig: string
}

export function certificateSigningInput(c: Omit<Certificate, "sig" | "v">) {
  return `voixex-cert:v1\n${c.certId}\n${c.serverId}\n${c.clientId}\n${c.publicKey}\n${c.issuedAt}`
}

/** What the client signs to log in; binds the signature to this server, certificate and challenge. */
export function loginSigningInput(serverId: string, certId: string, nonce: string) {
  return `voixex-login:v1\n${serverId}\n${certId}\n${nonce}`
}

export function parseEd25519PublicKey(base64: string): KeyObject | null {
  let raw: Buffer
  try {
    raw = Buffer.from(base64, "base64")
  } catch {
    return null
  }
  if (raw.length !== 32) return null
  try {
    return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" })
  } catch {
    return null
  }
}

export function verifyEd25519(publicKey: KeyObject, message: string, signatureBase64: string) {
  let signature: Buffer
  try {
    signature = Buffer.from(signatureBase64, "base64")
  } catch {
    return false
  }
  if (signature.length !== 64) return false
  try {
    return verify(null, Buffer.from(message, "utf8"), publicKey, signature)
  } catch {
    return false
  }
}

/** The server's certificate-signing key, created on first start and kept in the database. */
export function loadServerSigningKey(db: Database.Database): KeyObject {
  const row = db.prepare("SELECT value FROM server_secrets WHERE key = 'cert_signing_key'").get() as
    | { value: string }
    | undefined
  if (row) return createPrivateKey(row.value)
  const { privateKey } = generateKeyPairSync("ed25519")
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString()
  db.prepare("INSERT INTO server_secrets(key, value) VALUES ('cert_signing_key', ?)").run(pem)
  return privateKey
}

export function signCertificate(signingKey: KeyObject, c: Omit<Certificate, "sig" | "v">): Certificate {
  const sig = sign(null, Buffer.from(certificateSigningInput(c), "utf8"), signingKey).toString("base64")
  return { v: 1, ...c, sig }
}

export function normalizeNick(input: string) {
  return input.normalize("NFKC").replace(/\s+/g, " ").trim()
}

export function nickKey(nick: string) {
  return normalizeNick(nick).toLowerCase()
}

/** Letters/digits of any script plus space, dot, underscore and dash; 2–32 characters. */
export function isValidNick(nick: string) {
  return nick.length >= 2 && nick.length <= 32 && /^[\p{L}\p{N} ._-]+$/u.test(nick)
}

export function isValidPassword(password: string) {
  return password.length >= 8 && password.length <= 256
}

/** Single-use login challenges, bound to the certificate they were issued for. */
export class ChallengeStore {
  private readonly entries = new Map<string, { certId: string; expiresAt: number }>()

  constructor(
    private readonly ttlMs = 60_000,
    private readonly maxEntries = 10_000
  ) {}

  issue(certId: string) {
    this.prune()
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest) this.entries.delete(oldest)
    }
    const nonce = randomBytes(32).toString("base64url")
    this.entries.set(nonce, { certId, expiresAt: Date.now() + this.ttlMs })
    return { nonce, expiresInSec: Math.round(this.ttlMs / 1000) }
  }

  /** Removes the challenge whatever the outcome, so a nonce can never be tried twice. */
  consume(nonce: string, certId: string) {
    const entry = this.entries.get(nonce)
    this.entries.delete(nonce)
    return Boolean(entry && entry.certId === certId && entry.expiresAt >= Date.now())
  }

  private prune() {
    const now = Date.now()
    for (const [nonce, entry] of this.entries) {
      if (entry.expiresAt < now) this.entries.delete(nonce)
    }
  }
}

/** Fixed-window attempt counter (per key) used to slow down password guessing. */
export class AttemptLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number
  ) {}

  blocked(key: string) {
    const w = this.windows.get(key)
    if (!w || w.resetAt < Date.now()) return false
    return w.count >= this.limit
  }

  record(key: string) {
    const now = Date.now()
    const w = this.windows.get(key)
    if (!w || w.resetAt < now) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs })
    } else {
      w.count += 1
    }
    if (this.windows.size > 50_000) {
      for (const [k, v] of this.windows) if (v.resetAt < now) this.windows.delete(k)
    }
  }

  reset(key: string) {
    this.windows.delete(key)
  }
}
