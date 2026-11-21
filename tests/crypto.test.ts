// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'
import {
  readySodium,
  sealHandshakeToken,
  openHandshakeToken,
  generateEphemeralKeyPair,
  deriveHostSessionKeys,
  deriveGuestSessionKeys,
  calculateSafetyNumber,
  encryptDataFrame,
  decryptDataFrame,
  wipeBytes,
  encodeJsonPacket,
  encodeChunkPacket,
  decodePacket,
  HandshakePayload,
} from '../src/lib/crypto'

describe('GhostTunnel Cryptographic Core', () => {
  beforeAll(async () => {
    await readySodium()
  })

  it('seals and opens a handshake token with matching passkey', async () => {
    const payload: HandshakePayload = {
      role: 'host',
      sdp: 'v=0\r\no=- 42 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=sendrecv',
      pubKey: 'dGVzdC1wdWJsaWMta2V5LTEyMzQ1Njc4OWFiY2RlZjA=',
    }
    const passkey = 'GhostSecret2026'

    const token = await sealHandshakeToken(payload, passkey)
    expect(token.startsWith('GT1.')).toBe(true)

    const opened = await openHandshakeToken(token, passkey)
    expect(opened).toEqual(payload)
  })

  it('fails decryption cleanly when given an incorrect passkey', async () => {
    const payload: HandshakePayload = {
      role: 'guest',
      sdp: 'v=0\r\ns=-\r\na=recvonly',
      pubKey: 'Z3Vlc3QtcHViLWtleS0wOTg3NjU0MzIxZmVkY2Jh',
    }

    const token = await sealHandshakeToken(payload, 'CorrectPasskey123')
    await expect(openHandshakeToken(token, 'WrongPasskey456')).rejects.toThrow()
  })

  it('fails decryption if token data is tampered with', async () => {
    const payload: HandshakePayload = {
      role: 'host',
      sdp: 'v=0\r\ns=test',
      pubKey: 'aG9zdC1wdWJrZXktMDAwMDAwMDAwMDAwMDAwMDAw',
    }
    const passkey = 'ValidPasskey789'
    const token = await sealHandshakeToken(payload, passkey)

    // Flip a character in the base64 part
    const b64 = token.slice(4)
    const tamperedB64 =
      b64.slice(0, 10) +
      (b64[10] === 'A' ? 'B' : 'A') +
      b64.slice(11)
    const tamperedToken = `GT1.${tamperedB64}`

    await expect(openHandshakeToken(tamperedToken, passkey)).rejects.toThrow()
  })

  it('derives aligned directional session keys and wipes ephemeral private keys', async () => {
    const hostPair = await generateEphemeralKeyPair()
    const guestPair = await generateEphemeralKeyPair()

    // Keep copies of public keys
    const hostPub = new Uint8Array(hostPair.publicKey)
    const guestPub = new Uint8Array(guestPair.publicKey)

    const hostKeys = await deriveHostSessionKeys(hostPair, guestPub)
    const guestKeys = await deriveGuestSessionKeys(guestPair, hostPub)

    // Host.sharedTx must strictly equal Guest.sharedRx
    expect(hostKeys.sharedTx).toEqual(guestKeys.sharedRx)
    // Host.sharedRx must strictly equal Guest.sharedTx
    expect(hostKeys.sharedRx).toEqual(guestKeys.sharedTx)

    // Verify private keys were wiped (all zeros)
    expect(hostPair.privateKey.every((b) => b === 0)).toBe(true)
    expect(guestPair.privateKey.every((b) => b === 0)).toBe(true)
  })

  it('computes identical 6-digit Safety Numbers on Host and Guest', async () => {
    const hostPair = await generateEphemeralKeyPair()
    const guestPair = await generateEphemeralKeyPair()

    const hostSafety = calculateSafetyNumber(hostPair.publicKey, guestPair.publicKey)
    const guestSafety = calculateSafetyNumber(hostPair.publicKey, guestPair.publicKey)

    expect(hostSafety).toBe(guestSafety)
    expect(hostSafety).toMatch(/^\d{6}$/)
  })

  it('encrypts and decrypts DataChannel frames with sequence AAD validation', () => {
    const txKey = sodium.randombytes_buf(32)
    const rxKey = new Uint8Array(txKey) // In direct link, rx matches tx

    const rawMessage = sodium.from_string('Hello, GhostTunnel!')
    const seq = 0

    const frame = encryptDataFrame(rawMessage, txKey, seq)
    expect(frame.length).toBeGreaterThan(44)

    // Expected sequence 0 succeeds
    const decrypted = decryptDataFrame(frame, rxKey, 0)
    expect(sodium.to_string(decrypted)).toBe('Hello, GhostTunnel!')
  })

  it('rejects out-of-order or replayed frames via sequence check', () => {
    const txKey = sodium.randombytes_buf(32)
    const rxKey = new Uint8Array(txKey)

    const rawMessage = sodium.from_string('Protected Packet')
    const frameSeq0 = encryptDataFrame(rawMessage, txKey, 0)

    // Expecting sequence 1, but receiving sequence 0 (replay)
    expect(() => decryptDataFrame(frameSeq0, rxKey, 1)).toThrow(/Replay or out-of-order/)

    // Expecting sequence 0, but receiving sequence 5 (skip)
    const frameSeq5 = encryptDataFrame(rawMessage, txKey, 5)
    expect(() => decryptDataFrame(frameSeq5, rxKey, 0)).toThrow(/Replay or out-of-order/)
  })

  it('rejects tampered DataChannel frame ciphertext', () => {
    const txKey = sodium.randombytes_buf(32)
    const rxKey = new Uint8Array(txKey)

    const rawMessage = sodium.from_string('Sensitive Data')
    const frame = encryptDataFrame(rawMessage, txKey, 0)

    // Tamper with the last byte (part of Poly1305 MAC tag or ciphertext)
    frame[frame.length - 1] ^= 0x01

    expect(() => decryptDataFrame(frame, rxKey, 0)).toThrow()
  })

  it('wipeBytes zeroes out a Uint8Array buffer', () => {
    const sensitive = new Uint8Array([1, 2, 3, 4, 5, 42, 99, 255])
    expect(sensitive.some((b) => b !== 0)).toBe(true)

    wipeBytes(sensitive)
    expect(sensitive.every((b) => b === 0)).toBe(true)
  })

  it('correctly encodes and decodes tagged JSON and CHUNK packets', () => {
    // JSON Packet
    const textMsg = { type: 'TEXT', id: '123e4567-e89b-12d3-a456-426614174000', text: 'Secret', ttlSeconds: 15 }
    const encodedJson = encodeJsonPacket(textMsg)
    expect(encodedJson[0]).toBe(0x01)

    const decodedJson = decodePacket(encodedJson)
    expect(decodedJson).toEqual({ type: 'JSON', payload: textMsg })

    // CHUNK Packet
    const dummySlice = new Uint8Array([10, 20, 30, 40, 50])
    const uuid = '123e4567-e89b-12d3-a456-426614174000'
    const encodedChunk = encodeChunkPacket(3, uuid, dummySlice)
    expect(encodedChunk[0]).toBe(0x02)

    const decodedChunk = decodePacket(encodedChunk)
    expect(decodedChunk.type).toBe('CHUNK')
    if (decodedChunk.type === 'CHUNK') {
      expect(decodedChunk.chunkIndex).toBe(3)
      expect(decodedChunk.id).toBe(uuid)
      expect(Array.from(decodedChunk.data)).toEqual(Array.from(dummySlice))
    }
  })
})
