import rawSodium from 'libsodium-wrappers-sumo'

// Resolve default export whether bundled as ESM or CJS
const sodium = (rawSodium as any).default || rawSodium

export const PACKET_TAG_JSON = 0x01
export const PACKET_TAG_CHUNK = 0x02

export interface HandshakePayload {
  role: 'host' | 'guest'
  sdp: string
  pubKey: string // Base64URL encoded 32-byte public key
}

export interface DirectionalSessionKeys {
  sharedRx: Uint8Array
  sharedTx: Uint8Array
}

export interface EphemeralKeyPair {
  publicKey: Uint8Array
  privateKey: Uint8Array
  keyType: string
}

let isSodiumReady = false

/**
 * Ensures libsodium-wrappers-sumo is fully initialized.
 */
export async function readySodium(): Promise<typeof rawSodium> {
  if (!isSodiumReady) {
    await sodium.ready
    isSodiumReady = true
  }
  return sodium
}

/**
 * Converts bytes to Base64URL without padding.
 */
export async function toBase64Url(buf: Uint8Array): Promise<string> {
  const s = await readySodium()
  return s.to_base64(buf, s.base64_variants.URLSAFE_NO_PADDING)
}

/**
 * Parses Base64URL string into bytes.
 */
export async function fromBase64Url(str: string): Promise<Uint8Array> {
  const s = await readySodium()
  return s.from_base64(str, s.base64_variants.URLSAFE_NO_PADDING)
}

/**
 * Wipes a Uint8Array in volatile memory using sodium.memzero.
 */
export function wipeBytes(buf: Uint8Array): void {
  if (buf && buf.byteLength > 0) {
    sodium.memzero(buf)
  }
}

/**
 * Compresses raw bytes using native browser CompressionStream('deflate-raw').
 */
export async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  const buffer = await new Response(stream).arrayBuffer()
  return new Uint8Array(buffer)
}

/**
 * Decompresses raw bytes using native browser DecompressionStream('deflate-raw').
 */
export async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  const buffer = await new Response(stream).arrayBuffer()
  return new Uint8Array(buffer)
}

/**
 * Derives a 32-byte key from passkey and salt via Argon2id (crypto_pwhash).
 */
export function derivePasskeyKey(passkey: string, salt: Uint8Array): Uint8Array {
  if (passkey.length < 6) {
    throw new Error('Passkey must be at least 6 characters')
  }
  const passkeyBytes = sodium.from_string(passkey)
  try {
    return sodium.crypto_pwhash(
      sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES,
      passkeyBytes,
      salt,
      sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
      sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
      sodium.crypto_pwhash_ALG_ARGON2ID13
    )
  } finally {
    wipeBytes(passkeyBytes)
  }
}

/**
 * Compresses and seals a HandshakePayload with Argon2id + XChaCha20-Poly1305.
 * Output: GT1.<base64url(salt[16] || nonce[24] || ciphertext+tag)>
 */
export async function sealHandshakeToken(
  payload: HandshakePayload,
  passkey: string
): Promise<string> {
  await readySodium()

  const jsonStr = JSON.stringify(payload)
  const jsonBytes = sodium.from_string(jsonStr)
  const compressed = await deflateRaw(jsonBytes)
  wipeBytes(jsonBytes)

  const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES)
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
  const key = derivePasskeyKey(passkey, salt)

  let ciphertext: Uint8Array
  try {
    ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      compressed,
      null,
      null,
      nonce,
      key
    )
  } finally {
    wipeBytes(key)
    wipeBytes(compressed)
  }

  const packed = new Uint8Array(salt.length + nonce.length + ciphertext.length)
  packed.set(salt, 0)
  packed.set(nonce, salt.length)
  packed.set(ciphertext, salt.length + nonce.length)

  const b64 = sodium.to_base64(packed, sodium.base64_variants.URLSAFE_NO_PADDING)
  return `GT1.${b64}`
}

/**
 * Decrypts and decompresses a GT1.<base64url> token using the shared passkey.
 */
export async function openHandshakeToken(
  token: string,
  passkey: string
): Promise<HandshakePayload> {
  await readySodium()

  if (!token.startsWith('GT1.')) {
    throw new Error('Invalid token: missing GT1. prefix')
  }

  const b64 = token.slice(4).trim()
  if (!b64) {
    throw new Error('Empty token payload')
  }

  const packed = sodium.from_base64(b64, sodium.base64_variants.URLSAFE_NO_PADDING)
  const minLength =
    sodium.crypto_pwhash_SALTBYTES +
    sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES +
    sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES

  if (packed.length < minLength) {
    throw new Error('Invalid token: payload buffer is too short')
  }

  const saltBytes = sodium.crypto_pwhash_SALTBYTES
  const nonceBytes = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES

  const salt = packed.subarray(0, saltBytes)
  const nonce = packed.subarray(saltBytes, saltBytes + nonceBytes)
  const ciphertext = packed.subarray(saltBytes + nonceBytes)

  const key = derivePasskeyKey(passkey, salt)
  let decompressed: Uint8Array

  try {
    const decrypted = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      null,
      nonce,
      key
    )
    decompressed = await inflateRaw(decrypted)
    wipeBytes(decrypted)
  } finally {
    wipeBytes(key)
  }

  const jsonStr = sodium.to_string(decompressed)
  wipeBytes(decompressed)
  return JSON.parse(jsonStr) as HandshakePayload
}

/**
 * Generates an ephemeral X25519 keypair for session negotiation.
 */
export async function generateEphemeralKeyPair(): Promise<EphemeralKeyPair> {
  await readySodium()
  return sodium.crypto_kx_keypair()
}

/**
 * Derives Host directional session keys (crypto_kx_server_session_keys).
 * Immediately wipes the ephemeral private key.
 */
export async function deriveHostSessionKeys(
  hostKeyPair: EphemeralKeyPair,
  guestPubKey: Uint8Array
): Promise<DirectionalSessionKeys> {
  await readySodium()
  try {
    return sodium.crypto_kx_server_session_keys(
      hostKeyPair.publicKey,
      hostKeyPair.privateKey,
      guestPubKey
    )
  } finally {
    wipeBytes(hostKeyPair.privateKey)
  }
}

/**
 * Derives Guest directional session keys (crypto_kx_client_session_keys).
 * Immediately wipes the ephemeral private key.
 */
export async function deriveGuestSessionKeys(
  guestKeyPair: EphemeralKeyPair,
  hostPubKey: Uint8Array
): Promise<DirectionalSessionKeys> {
  await readySodium()
  try {
    return sodium.crypto_kx_client_session_keys(
      guestKeyPair.publicKey,
      guestKeyPair.privateKey,
      hostPubKey
    )
  } finally {
    wipeBytes(guestKeyPair.privateKey)
  }
}

/**
 * Computes a deterministic 6-digit Safety Number from BLAKE2b(hostPubKey || guestPubKey) % 1,000,000.
 */
export function calculateSafetyNumber(
  hostPubKey: Uint8Array,
  guestPubKey: Uint8Array
): string {
  const combined = new Uint8Array(hostPubKey.length + guestPubKey.length)
  combined.set(hostPubKey, 0)
  combined.set(guestPubKey, hostPubKey.length)

  const hash = sodium.crypto_generichash(32, combined)
  const view = new DataView(hash.buffer, hash.byteOffset, hash.byteLength)
  const num = view.getUint32(0, false) % 1_000_000
  return String(num).padStart(6, '0')
}

/**
 * Encrypts a DataChannel frame with XChaCha20-Poly1305.
 * Format: [4B big-endian seq | 24B nonce | ciphertext + 16B tag]
 * AAD: 4-byte big-endian sequence buffer.
 */
export function encryptDataFrame(
  packet: Uint8Array,
  txKey: Uint8Array,
  seq: number
): Uint8Array {
  const aad = new Uint8Array(4)
  const view = new DataView(aad.buffer, aad.byteOffset, 4)
  view.setUint32(0, seq, false)

  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    packet,
    aad,
    null,
    nonce,
    txKey
  )

  const frame = new Uint8Array(4 + nonce.length + ciphertext.length)
  frame.set(aad, 0)
  frame.set(nonce, 4)
  frame.set(ciphertext, 4 + nonce.length)
  return frame
}

/**
 * Decrypts a DataChannel frame with XChaCha20-Poly1305.
 * Enforces monotonic sequence ordering: rejects replay or out-of-order packets.
 */
export function decryptDataFrame(
  frame: Uint8Array,
  rxKey: Uint8Array,
  expectedSeq: number
): Uint8Array {
  const minLength =
    4 +
    sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES +
    sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES

  if (frame.length < minLength) {
    throw new Error('Frame too short: invalid packet')
  }

  const view = new DataView(frame.buffer, frame.byteOffset, 4)
  const seq = view.getUint32(0, false)

  if (seq !== expectedSeq) {
    throw new Error(
      `Replay or out-of-order frame detected: received seq ${seq}, expected ${expectedSeq}`
    )
  }

  const aad = frame.subarray(0, 4)
  const nonceBytes = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
  const nonce = frame.subarray(4, 4 + nonceBytes)
  const ciphertext = frame.subarray(4 + nonceBytes)

  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ciphertext,
    aad,
    nonce,
    rxKey
  )
}

/**
 * Encodes a JSON message into a tagged plaintext packet (0x01 | JSON bytes).
 */
export function encodeJsonPacket(data: object): Uint8Array {
  const jsonStr = JSON.stringify(data)
  const jsonBytes = sodium.from_string(jsonStr)
  const packet = new Uint8Array(1 + jsonBytes.length)
  packet[0] = PACKET_TAG_JSON
  packet.set(jsonBytes, 1)
  return packet
}

/**
 * Encodes a binary photo slice into a tagged chunk packet:
 * [1B tag (0x02) | 4B uint32 chunkIndex | 36B ASCII UUID | slice]
 */
export function encodeChunkPacket(
  chunkIndex: number,
  uuid: string,
  slice: Uint8Array
): Uint8Array {
  if (uuid.length !== 36) {
    throw new Error('Chunk UUID must be 36 characters')
  }
  const uuidBytes = sodium.from_string(uuid)
  const packet = new Uint8Array(1 + 4 + 36 + slice.length)
  packet[0] = PACKET_TAG_CHUNK

  const view = new DataView(packet.buffer, packet.byteOffset + 1, 4)
  view.setUint32(0, chunkIndex, false)

  packet.set(uuidBytes, 5)
  packet.set(slice, 41)
  return packet
}

export type DecodedPacket =
  | { type: 'JSON'; payload: any }
  | { type: 'CHUNK'; chunkIndex: number; id: string; data: Uint8Array }

/**
 * Decodes a tagged plaintext packet.
 */
export function decodePacket(packet: Uint8Array): DecodedPacket {
  if (packet.length < 1) {
    throw new Error('Empty packet')
  }

  const tag = packet[0]
  if (tag === PACKET_TAG_JSON) {
    const jsonBytes = packet.subarray(1)
    const jsonStr = sodium.to_string(jsonBytes)
    return { type: 'JSON', payload: JSON.parse(jsonStr) }
  } else if (tag === PACKET_TAG_CHUNK) {
    if (packet.length < 41) {
      throw new Error('Chunk packet too short')
    }
    const view = new DataView(packet.buffer, packet.byteOffset + 1, 4)
    const chunkIndex = view.getUint32(0, false)
    const uuidBytes = packet.subarray(5, 41)
    const id = sodium.to_string(uuidBytes)
    const data = new Uint8Array(packet.subarray(41))
    return { type: 'CHUNK', chunkIndex, id, data }
  } else {
    throw new Error(`Unknown packet tag: ${tag}`)
  }
}
