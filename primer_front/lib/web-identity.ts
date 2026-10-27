import * as ed from "@noble/ed25519"
import { scryptAsync } from "@noble/hashes/scrypt"
import type { VoixexStoredIdentity } from "@/types/electron-voice"

/**
 * Device certificates for the mobile app: same API as the desktop identity store
 * (desktop-client/src/identity-store.ts) and the same .voixexkey export format, so a
 * certificate moves between phone and computer in both directions.
 *
 * Keys live in the app's private WebView storage (not readable by other apps).
 */

type Certificate = NonNullable<VoixexStoredIdentity["certificate"]>
type Meta = VoixexStoredIdentity["meta"]
type ServerInfo = { label?: string; authMode?: string; apiHost?: string; apiPort?: string; apiUseHttps?: boolean }
type Stored = { publicKey: string; privateSeed: string; certificate: Certificate | null; createdAt: string; meta?: Meta }

const STORE_KEY = "voixex-identities-v1"
const SCRYPT = { N: 1 << 15, r: 8, p: 1 }
/** PKCS#8 DER prefix of an Ed25519 private key; the 32-byte seed follows. */
const PKCS8_ED25519_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20])

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
const utf8 = new TextEncoder()

function readAll(): Record<string, Stored> {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, Stored>) : {}
  } catch {
    return {}
  }
}

function writeAll(data: Record<string, Stored>) {
  localStorage.setItem(STORE_KEY, JSON.stringify(data))
}

function save(seed: Uint8Array, publicKey: string, certificate: Certificate | null, meta?: Meta) {
  const ref = crypto.randomUUID()
  const all = readAll()
  all[ref] = { publicKey, privateSeed: b64(seed), certificate, createdAt: new Date().toISOString(), ...(meta ? { meta } : {}) }
  writeAll(all)
  return ref
}

function seedToPem(seed: Uint8Array) {
  const der = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32)
  der.set(PKCS8_ED25519_PREFIX)
  der.set(seed, PKCS8_ED25519_PREFIX.length)
  const body = b64(der).replace(/.{1,64}/g, "$&\n")
  return `-----BEGIN PRIVATE KEY-----\n${body}-----END PRIVATE KEY-----\n`
}

function pemToSeed(pem: string) {
  const der = unb64(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""))
  const prefixOk = der.length === PKCS8_ED25519_PREFIX.length + 32 && PKCS8_ED25519_PREFIX.every((b, i) => der[i] === b)
  if (!prefixOk) throw new Error("The certificate file is damaged")
  return der.slice(PKCS8_ED25519_PREFIX.length)
}

async function fileKey(passphrase: string, salt: Uint8Array, kdf = SCRYPT) {
  const raw = await scryptAsync(utf8.encode(passphrase), salt, { ...kdf, dkLen: 32, maxmem: 64 * 1024 * 1024 + 1024 })
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"])
}

/** Saves a text file: share sheet in the Android app, a download in a browser. */
async function saveTextFile(name: string, contents: string): Promise<string | null> {
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
  if (cap?.isNativePlatform?.()) {
    const { Filesystem, Directory, Encoding } = await import("@capacitor/filesystem")
    const { Share } = await import("@capacitor/share")
    const written = await Filesystem.writeFile({ path: name, data: contents, directory: Directory.Cache, encoding: Encoding.UTF8 })
    await Share.share({ title: name, files: [written.uri] })
    return name
  }
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }))
  const a = document.createElement("a")
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return name
}

export const webIdentity: NonNullable<Window["voixexIdentity"]> = {
  async create() {
    const seed = ed.utils.randomPrivateKey()
    const publicKey = b64(await ed.getPublicKeyAsync(seed))
    return { ref: save(seed, publicKey, null), publicKey }
  },

  async setCertificate(ref, certificate) {
    const all = readAll()
    const entry = all[ref]
    if (!entry) throw new Error("Certificate not found on this device")
    if (certificate.publicKey !== entry.publicKey) throw new Error("Certificate does not match this device key")
    entry.certificate = certificate
    writeAll(all)
  },

  async get(ref) {
    const entry = readAll()[ref]
    return entry ? { publicKey: entry.publicKey, certificate: entry.certificate } : null
  },

  async sign(ref, message) {
    const entry = readAll()[ref]
    if (!entry) throw new Error("Certificate not found on this device")
    return b64(await ed.signAsync(utf8.encode(message), unb64(entry.privateSeed)))
  },

  async remove(ref) {
    const all = readAll()
    delete all[ref]
    writeAll(all)
  },

  async list() {
    return Object.entries(readAll()).map(([ref, e]) => ({
      ref,
      publicKey: e.publicKey,
      certificate: e.certificate,
      createdAt: e.createdAt,
      meta: e.meta ?? {}
    }))
  },

  async setMeta(ref, meta) {
    const all = readAll()
    const entry = all[ref]
    if (!entry) return
    entry.meta = { ...entry.meta, ...Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined)) }
    writeAll(all)
  },

  async exportToFile(ref, passphrase, server: ServerInfo) {
    const entry = readAll()[ref]
    if (!entry?.certificate) throw new Error("This server has no certificate to export yet")
    if (passphrase.length < 8) throw new Error("Use at least 8 characters to protect the file")
    const plaintext = JSON.stringify({
      privateKey: seedToPem(unb64(entry.privateSeed)),
      publicKey: entry.publicKey,
      certificate: entry.certificate,
      server
    })
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await fileKey(passphrase, salt), utf8.encode(plaintext)))
    const file = {
      format: "voixex-identity",
      v: 1,
      kdf: { name: "scrypt", ...SCRYPT, salt: b64(salt) },
      cipher: "aes-256-gcm",
      iv: b64(iv),
      tag: b64(sealed.slice(-16)),
      data: b64(sealed.slice(0, -16))
    }
    const safeLabel = (server.label || "server").replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 40)
    return saveTextFile(`${safeLabel}.voixexkey`, JSON.stringify(file, null, 2))
  },

  async pickImportFile() {
    return new Promise((resolve) => {
      const input = document.createElement("input")
      input.type = "file"
      // Android file pickers do not know the .voixexkey extension: accept any file.
      input.accept = ".voixexkey,application/json,application/octet-stream,*/*"
      input.onchange = () => {
        const file = input.files?.[0]
        if (!file) return resolve(null)
        void file.text().then((contents) => resolve({ path: file.name, contents }))
      }
      input.oncancel = () => resolve(null)
      input.click()
    })
  },

  async importFromFile(contents, passphrase) {
    let file: { format?: string; v?: number; cipher?: string; kdf: { N: number; r: number; p: number; salt: string }; iv: string; tag: string; data: string }
    try {
      file = JSON.parse(contents)
    } catch {
      throw new Error("This is not a Voixex certificate file")
    }
    if (file?.format !== "voixex-identity" || file.v !== 1 || file.cipher !== "aes-256-gcm") {
      throw new Error("This is not a Voixex certificate file")
    }
    let plaintext: string
    try {
      const key = await fileKey(passphrase, unb64(file.kdf.salt), { N: file.kdf.N, r: file.kdf.r, p: file.kdf.p })
      const sealed = new Uint8Array([...unb64(file.data), ...unb64(file.tag)])
      plaintext = new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(file.iv) }, key, sealed))
    } catch {
      throw new Error("Wrong password for this certificate file")
    }
    const parsed = JSON.parse(plaintext) as { privateKey: string; publicKey: string; certificate: Certificate; server?: ServerInfo }
    const seed = pemToSeed(parsed.privateKey)
    // Make sure the key really belongs to the certificate before trusting the file.
    const derived = b64(await ed.getPublicKeyAsync(seed))
    if (derived !== parsed.publicKey || parsed.certificate?.publicKey !== parsed.publicKey) {
      throw new Error("The certificate file is damaged")
    }
    const server = parsed.server ?? {}
    const ref = save(seed, parsed.publicKey, parsed.certificate, {
      label: server.label,
      address: server.apiHost ? (server.apiPort ? `${server.apiHost}:${server.apiPort}` : server.apiHost) : undefined,
      secure: server.apiUseHttps
    })
    return { ref, publicKey: parsed.publicKey, certificate: parsed.certificate, server }
  }
}
