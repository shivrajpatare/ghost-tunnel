// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import {
  readySodium,
  deriveHostSessionKeys,
  deriveGuestSessionKeys,
  generateEphemeralKeyPair,
  wipeBytes,
} from '../src/lib/crypto'
import {
  sliceIntoChunks,
  reassembleChunks,
  getIceServers,
  PhotoAssembler,
  MAX_CHUNK_SLICE_BYTES,
  MAX_TOTAL_CHUNKS,
  GhostTunnelWebRTC,
} from '../src/lib/webrtc'

describe('GhostTunnel WebRTC Chunker & Transport Protocol', () => {
  beforeAll(async () => {
    await readySodium()
  })

  it('slices a buffer into 16,000-byte chunks correctly', () => {
    // 48,500 bytes -> 3 full 16,000B chunks + 1 partial 500B chunk
    const totalSize = 48500
    const dummyData = new Uint8Array(totalSize)
    for (let i = 0; i < totalSize; i++) {
      dummyData[i] = i % 256
    }

    const slices = sliceIntoChunks(dummyData, MAX_CHUNK_SLICE_BYTES)
    expect(slices.length).toBe(4)
    expect(slices[0].length).toBe(16000)
    expect(slices[1].length).toBe(16000)
    expect(slices[2].length).toBe(16000)
    expect(slices[3].length).toBe(500)

    const reassembled = reassembleChunks(slices)
    expect(reassembled.length).toBe(totalSize)
    expect(reassembled).toEqual(dummyData)
  })

  it('PhotoAssembler handles out-of-order chunks and ignores duplicates', () => {
    const assembler = new PhotoAssembler()
    const id = '123e4567-e89b-12d3-a456-426614174000'
    const totalChunks = 3

    const accepted = assembler.registerMeta({
      type: 'PHOTO_META',
      id,
      totalChunks,
      ttlSeconds: 6,
      mimeType: 'image/webp',
    })
    expect(accepted).toBe(true)

    const slice0 = new Uint8Array([1, 2, 3])
    const slice1 = new Uint8Array([4, 5])
    const slice2 = new Uint8Array([6, 7, 8, 9])

    // Deliver chunk 2 first
    const res2 = assembler.addChunk(id, 2, slice2)
    expect(res2?.photo).toBeUndefined()
    expect(res2?.progress).toEqual({ received: 1, total: 3 })

    // Duplicate chunk 2 delivery (should be ignored, count remains 1)
    const res2Dup = assembler.addChunk(id, 2, slice2)
    expect(res2Dup?.photo).toBeUndefined()
    expect(res2Dup?.progress).toEqual({ received: 1, total: 3 })

    // Deliver chunk 0
    const res0 = assembler.addChunk(id, 0, slice0)
    expect(res0?.photo).toBeUndefined()
    expect(res0?.progress).toEqual({ received: 2, total: 3 })

    // Deliver chunk 1 (final piece)
    const res1 = assembler.addChunk(id, 1, slice1)
    expect(res1?.photo).toBeDefined()
    expect(res1?.photo?.id).toBe(id)
    expect(res1?.photo?.mimeType).toBe('image/webp')
    expect(Array.from(res1!.photo!.data)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('PhotoAssembler rejects invalid totalChunks or out-of-bound chunkIndex', () => {
    const assembler = new PhotoAssembler()

    // totalChunks = 0 rejected
    expect(
      assembler.registerMeta({
        type: 'PHOTO_META',
        id: 'bad-0',
        totalChunks: 0,
        ttlSeconds: 5,
        mimeType: 'image/webp',
      })
    ).toBe(false)

    // totalChunks > MAX_TOTAL_CHUNKS (512) rejected
    expect(
      assembler.registerMeta({
        type: 'PHOTO_META',
        id: 'bad-513',
        totalChunks: MAX_TOTAL_CHUNKS + 1,
        ttlSeconds: 5,
        mimeType: 'image/webp',
      })
    ).toBe(false)

    // Valid registration
    assembler.registerMeta({
      type: 'PHOTO_META',
      id: 'valid-id',
      totalChunks: 2,
      ttlSeconds: 5,
      mimeType: 'image/jpeg',
    })

    // Out of bound chunkIndex
    expect(assembler.addChunk('valid-id', -1, new Uint8Array([1]))).toBeNull()
    expect(assembler.addChunk('valid-id', 2, new Uint8Array([1]))).toBeNull()
    expect(assembler.addChunk('unknown-id', 0, new Uint8Array([1]))).toBeNull()
  })

  it('validates ICE server modes and custom TURN URLs', () => {
    expect(getIceServers('zero-server')).toEqual([])
    expect(getIceServers('stun-p2p')).toEqual([{ urls: 'stun:stun.l.google.com:19302' }])

    // Valid TURN
    const turnConfig = {
      url: 'turn:turn.example.com:3478',
      username: 'user1',
      credential: 'secretpassword',
    }
    const turnServers = getIceServers('custom-turn', turnConfig)
    expect(turnServers).toEqual([
      { urls: 'turn:turn.example.com:3478', username: 'user1', credential: 'secretpassword' },
    ])

    // Invalid TURN URLs
    expect(() => getIceServers('custom-turn', { url: '' })).toThrow(/requires a valid URL/)
    expect(() => getIceServers('custom-turn', { url: 'http://example.com' })).toThrow(
      /must start with turn: or turns:/
    )
  })

  it('maintains serialized atomic sequence order under simulated packet flow', async () => {
    const hostPair = await generateEphemeralKeyPair()
    const guestPair = await generateEphemeralKeyPair()

    const hostKeys = await deriveHostSessionKeys(hostPair, guestPair.publicKey)
    const guestKeys = await deriveGuestSessionKeys(guestPair, hostPair.publicKey)

    const hostTunnel = new GhostTunnelWebRTC(hostKeys)
    const guestTunnel = new GhostTunnelWebRTC(guestKeys)

    // Mock an in-memory loopback DataChannel connection between host and guest
    const sentFrames: Uint8Array[] = []

    const mockHostDc: any = {
      readyState: 'open',
      bufferedAmount: 0,
      send: (data: Uint8Array) => {
        sentFrames.push(new Uint8Array(data))
        // Pass immediately to guest dc
        if (mockGuestDc.onmessage) {
          mockGuestDc.onmessage({ data: data.buffer } as MessageEvent)
        }
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    }

    const mockGuestDc: any = {
      readyState: 'open',
      bufferedAmount: 0,
      send: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    }

    hostTunnel.dc = mockHostDc
    guestTunnel.attachDataChannel(mockGuestDc)

    const receivedEvents: any[] = []
    guestTunnel.onEvent((evt) => {
      receivedEvents.push(evt)
    })

    // Queue 1 text message, 1 photo with 3 chunks, and another text message
    await hostTunnel.sendTextMessage('Message 1', 10)

    const dummyPhotoData = new Uint8Array(40000) // ~3 chunks
    dummyPhotoData.fill(77)
    await hostTunnel.sendPhoto({
      data: dummyPhotoData,
      mimeType: 'image/webp',
      width: 800,
      height: 600,
    })

    await hostTunnel.sendTextMessage('Message 2', 15)

    // Verify frames received:
    // Frame 0: Message 1 (JSON)
    // Frame 1: Photo Meta (JSON)
    // Frame 2: Chunk 0 (CHUNK)
    // Frame 3: Chunk 1 (CHUNK)
    // Frame 4: Chunk 2 (CHUNK)
    // Frame 5: Message 2 (JSON)
    expect(sentFrames.length).toBe(6)

    // Verify that guest processed all in strict order without replay or sequence errors
    const textMessages = receivedEvents.filter((e) => e.type === 'message')
    expect(textMessages.length).toBe(2)
    expect(textMessages[0].message.text).toBe('Message 1')
    expect(textMessages[1].message.text).toBe('Message 2')

    const photoEvents = receivedEvents.filter((e) => e.type === 'photo')
    expect(photoEvents.length).toBe(1)
    expect(photoEvents[0].photo.data.length).toBe(40000)
    expect(photoEvents[0].photo.mimeType).toBe('image/webp')

    // Clean up
    hostTunnel.closeSession()
    guestTunnel.closeSession()
  })

  it('wipes memory when reassembling and closing session', () => {
    const sensitive = new Uint8Array([55, 66, 77, 88])
    const slices = sliceIntoChunks(sensitive, 2)

    const reassembled = reassembleChunks(slices)
    expect(reassembled.every((b) => b !== 0)).toBe(true)

    wipeBytes(reassembled)
    expect(reassembled.every((b) => b === 0)).toBe(true)
  })
})
