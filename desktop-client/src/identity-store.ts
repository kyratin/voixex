import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, scryptSync, sign } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { safeStorage } from "electron"

/**
 * Device certificates for Voixex servers. Each server gets its own Ed25519 key; the private key
 * is encrypted with the OS keychain (safeStorage) and never leaves the main process — the UI
 * only gets the public key, the server-issued certificate and signatures.
 */

export type ServerCertificate = {
  v: 1
  certId: string
  serverId: string
  clientId: string
  publicKey: string
  issuedAt: string
  sig: string
}

/** Connection details stored in an exported file so it can be imported on another computer. */
export type IdentityServerInfo = {
  label?: string
  /** Protection level of the profile, so an import knows whether nick + password are needed. */
  authMode?: string
  apiHost?: string
  apiPort?: string
  apiUseHttps?: boolean
}

type StoredIdentity = {
  publicKey: string
  /** PKCS#8 PEM encrypted by safeStorage, base64. */
  privateKeyEnc: string
  certificate: ServerCertificate | null
  createdAt: string
}

type StoreFile = { version: 1; identities: Record<string, StoredIdentity> }

type ExportFile = {
  format: "voixex-identity"
  v: 1
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string }
  cipher: "aes-256-gcm"
  iv: string
  tag: string
  data: string
}

const SCRYPT = { N: 1 << 15, r: 8, p: 1 }
const SCRYPT_MAXMEM = 64 * 1024 * 1024

export class IdentityStore {
  constructor(private readonly filePath: string) {}

  private ensureEncryption() {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Secure key storage is not available on this system (OS keychain is required)")
    }
  }

  private read(): StoreFile {
    if (!existsSync(this.filePath)) return { version: 1, identities: {} }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as StoreFile
      return parsed && parsed.identities ? parsed : { version: 1, identities: {} }
    } catch {
      return { version: 1, identities: {} }
    }
  }

  private write(data: StoreFile) {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
    renameSync(tmp, this.filePath)
  }

  private privateKey(ref: string) {
    const entry = this.read().identities[ref]
    if (!entry) throw new Error("Certificate not found on this device")
    this.ensureEncryption()
    const pem = safeStorage.decryptString(Buffer.from(entry.privateKeyEnc, "base64"))
    return createPrivateKey(pem)
  }

  private save(publicKey: string, pkcs8Pem: string, certificate: ServerCertificate | null) {
    this.ensureEncryption()
    const ref = randomUUID()
    const data = this.read()
    data.identities[ref] = {
      publicKey,
      privateKeyEnc: safeStorage.encryptString(pkcs8Pem).toString("base64"),
      certificate,
      createdAt: new Date().toISOString()
    }
    this.write(data)
    return ref
  }

  /** New key pair for a registration; the certificate is attached once the server issues it. */
  create() {
    this.ensureEncryption()
    const { publicKey, privateKey } = generateKeyPairSync("ed25519")
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64")
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString()
    const ref = this.save(raw, pem, null)
    return { ref, publicKey: raw }
  }

  setCertificate(ref: string, certificate: ServerCertificate) {
    const data = this.read()
    const entry = data.identities[ref]
    if (!entry) throw new Error("Certificate not found on this device")
    if (certificate.publicKey !== entry.publicKey) throw new Error("Certificate does not match this device key")
    entry.certificate = certificate
    this.write(data)
  }

  get(ref: string) {
    const entry = this.read().identities[ref]
    if (!entry) return null
    return { publicKey: entry.publicKey, certificate: entry.certificate }
  }

  sign(ref: string, message: string) {
    return sign(null, Buffer.from(message, "utf8"), this.privateKey(ref)).toString("base64")
  }

  remove(ref: string) {
    const data = this.read()
    if (!data.identities[ref]) return
    delete data.identities[ref]
    this.write(data)
  }

  /** Serialized, passphrase-encrypted copy of the key + certificate for moving to another computer. */
  exportEncrypted(ref: string, passphrase: string, server: IdentityServerInfo) {
    const entry = this.read().identities[ref]
    if (!entry?.certificate) throw new Error("This server has no certificate to export yet")
    if (passphrase.length < 8) throw new Error("Use at least 8 characters to protect the file")
    const pem = this.privateKey(ref).export({ format: "pem", type: "pkcs8" }).toString()
    const plaintext = JSON.stringify({ privateKey: pem, publicKey: entry.publicKey, certificate: entry.certificate, server })
    const salt = randomBytes(16)
    const key = scryptSync(passphrase, salt, 32, { ...SCRYPT, maxmem: SCRYPT_MAXMEM })
    const iv = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", key, iv)
    const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
    const file: ExportFile = {
      format: "voixex-identity",
      v: 1,
      kdf: { name: "scrypt", ...SCRYPT, salt: salt.toString("base64") },
      cipher: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64")
    }
    return JSON.stringify(file, null, 2)
  }

  /** Decrypts an exported file and stores it as a new local identity. */
  importEncrypted(contents: string, passphrase: string) {
    let file: ExportFile
    try {
      file = JSON.parse(contents) as ExportFile
    } catch {
      throw new Error("This is not a Voixex certificate file")
    }
    if (file?.format !== "voixex-identity" || file.v !== 1 || file.cipher !== "aes-256-gcm") {
      throw new Error("This is not a Voixex certificate file")
    }
    const key = scryptSync(passphrase, Buffer.from(file.kdf.salt, "base64"), 32, {
      N: file.kdf.N,
      r: file.kdf.r,
      p: file.kdf.p,
      maxmem: SCRYPT_MAXMEM
    })
    let plaintext: string
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(file.iv, "base64"))
      decipher.setAuthTag(Buffer.from(file.tag, "base64"))
      plaintext = Buffer.concat([decipher.update(Buffer.from(file.data, "base64")), decipher.final()]).toString("utf8")
    } catch {
      throw new Error("Wrong password for this certificate file")
    }
    const parsed = JSON.parse(plaintext) as {
      privateKey: string
      publicKey: string
      certificate: ServerCertificate
      server?: IdentityServerInfo
    }
    // Make sure the key really belongs to the certificate before trusting the file.
    const derivedPublic = createPublicKey(createPrivateKey(parsed.privateKey))
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("base64")
    if (derivedPublic !== parsed.publicKey || parsed.certificate?.publicKey !== parsed.publicKey) {
      throw new Error("The certificate file is damaged")
    }
    const ref = this.save(parsed.publicKey, parsed.privateKey, parsed.certificate)
    return { ref, publicKey: parsed.publicKey, certificate: parsed.certificate, server: parsed.server ?? {} }
  }
}
