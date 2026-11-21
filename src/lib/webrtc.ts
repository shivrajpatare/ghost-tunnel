import {
  DirectionalSessionKeys,
  encryptDataFrame,
  decryptDataFrame,
  encodeJsonPacket,
  encodeChunkPacket,
  decodePacket,
  wipeBytes,
} from './crypto'

export type IceMode = 'zero-server' | 'stun-p2p' | 'custom-turn'

export interface TurnConfig {
  url: string
  username?: string
  credential?: string
}

export const MAX_CHUNK_SLICE_BYTES = 16000
export const MAX_TOTAL_CHUNKS = 512
export const BUFFERED_AMOUNT_HIGH_THRESHOLD = 262144 // 256 KB

/**
 * Validates TURN URL and returns RTCIceServer configuration.
 */
export function getIceServers(mode: IceMode, turnConfig?: TurnConfig): RTCIceServer[] {
  if (mode === 'zero-server') {
    return []
  }
  if (mode === 'stun-p2p') {
    return [{ urls: 'stun:stun.l.google.com:19302' }]
  }
  if (mode === 'custom-turn') {
    if (!turnConfig || !turnConfig.url || !turnConfig.url.trim()) {
      throw new Error('Custom TURN mode requires a valid URL')
    }
    const url = turnConfig.url.trim()
    if (!url.startsWith('turn:') && !url.startsWith('turns:')) {
      throw new Error('Invalid TURN URL: must start with turn: or turns:')
    }
    const server: RTCIceServer = { urls: url }
    if (turnConfig.username) server.username = turnConfig.username.trim()
    if (turnConfig.credential) server.credential = turnConfig.credential.trim()
    return [server]
  }
  return []
}

/**
 * Waits for ICE candidate gathering to finish with a fallback timeout (default 3500ms).
 */
export function waitForIceGathering(
  pc: RTCPeerConnection,
  timeoutMs = 3500
): Promise<void> {
  if (pc.iceGatheringState === 'complete') {
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    let resolved = false

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true
        pc.removeEventListener('icegatheringstatechange', checkState)
        resolve()
      }
    }, timeoutMs)

    const checkState = () => {
      if (pc.iceGatheringState === 'complete' && !resolved) {
        resolved = true
        clearTimeout(timer)
        pc.removeEventListener('icegatheringstatechange', checkState)
        resolve()
      }
    }

    pc.addEventListener('icegatheringstatechange', checkState)
  })
}

/**
 * Generates an RFC4122 v4 UUID.
 */
export function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

export interface SanitizedImage {
  data: Uint8Array
  mimeType: string
  width: number
  height: number
}

/**
 * Decodes an image Blob/File, strips EXIF metadata via canvas re-encoding, and scales to maxDimension.
 */
export async function sanitizeImage(
  file: Blob,
  maxDimension = 1440
): Promise<SanitizedImage> {
  if (typeof document === 'undefined' || typeof HTMLCanvasElement === 'undefined') {
    // Non-browser fallback: return raw bytes
    const buf = new Uint8Array(await file.arrayBuffer())
    return { data: buf, mimeType: file.type || 'image/webp', width: 0, height: 0 }
  }

  const bitmap = await createImageBitmap(file)
  const origW = bitmap.width
  const origH = bitmap.height

  let targetW = origW
  let targetH = origH

  if (origW > maxDimension || origH > maxDimension) {
    if (origW >= origH) {
      targetW = maxDimension
      targetH = Math.round((origH / origW) * maxDimension)
    } else {
      targetH = maxDimension
      targetW = Math.round((origW / origH) * maxDimension)
    }
  }

  const canvas = document.createElement('canvas')
  canvas.width = targetW
  canvas.height = targetH
  const ctx = canvas.getContext('2d')

  if (!ctx) {
    bitmap.close()
    throw new Error('Canvas 2D context not available')
  }

  ctx.drawImage(bitmap, 0, 0, targetW, targetH)
  bitmap.close()

  // Prefer WebP with fallback
  const blob: Blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => {
        if (b) resolve(b)
        else {
          canvas.toBlob(
            (fallbackBlob) => {
              if (fallbackBlob) resolve(fallbackBlob)
              else reject(new Error('Failed to encode canvas to blob'))
            },
            'image/jpeg',
            0.85
          )
        }
      },
      'image/webp',
      0.82
    )
  })

  // Blank and collapse offscreen canvas
  ctx.clearRect(0, 0, targetW, targetH)
  canvas.width = 0
  canvas.height = 0

  const arrayBuffer = await blob.arrayBuffer()
  const data = new Uint8Array(arrayBuffer)
  return {
    data,
    mimeType: blob.type || 'image/webp',
    width: targetW,
    height: targetH,
  }
}

/**
 * Slices a contiguous byte array into slices capped at chunkSize (default 16000 bytes).
 */
export function sliceIntoChunks(
  data: Uint8Array,
  chunkSize = MAX_CHUNK_SLICE_BYTES
): Uint8Array[] {
  const chunks: Uint8Array[] = []
  let offset = 0
  while (offset < data.length) {
    const end = Math.min(offset + chunkSize, data.length)
    chunks.push(data.subarray(offset, end))
    offset = end
  }
  return chunks
}

/**
 * Reassembles an array of contiguous chunk slices into a single Uint8Array.
 */
export function reassembleChunks(chunks: (Uint8Array | null)[]): Uint8Array {
  for (let i = 0; i < chunks.length; i++) {
    if (!chunks[i]) {
      throw new Error(`Cannot reassemble: missing chunk at index ${i}`)
    }
  }
  const validChunks = chunks as Uint8Array[]
  const totalLength = validChunks.reduce((acc, c) => acc + c.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const c of validChunks) {
    result.set(c, offset)
    offset += c.length
  }
  return result
}

export interface InFlightPhoto {
  id: string
  totalChunks: number
  receivedCount: number
  receivedIndices: Set<number>
  chunks: (Uint8Array | null)[]
  ttlSeconds: number
  mimeType: string
}

export interface ReceivedPhoto {
  id: string
  data: Uint8Array
  mimeType: string
  ttlSeconds: number
}

export interface TextMessagePayload {
  type: 'TEXT'
  id: string
  text: string
  ttlSeconds: number
}

export interface PhotoMetaPayload {
  type: 'PHOTO_META'
  id: string
  totalChunks: number
  ttlSeconds: number
  mimeType: string
}

export interface BurnAckPayload {
  type: 'BURN_ACK'
  id: string
}

export type TunnelEvent =
  | { type: 'message'; message: TextMessagePayload }
  | { type: 'photo'; photo: ReceivedPhoto }
  | { type: 'burn_ack'; id: string }
  | { type: 'photo_progress'; id: string; received: number; total: number }
  | { type: 'error'; error: Error }
  | { type: 'close' }

/**
 * In-memory Receiver state manager for reassembling photos with bounds checking.
 */
export class PhotoAssembler {
  private inFlight = new Map<string, InFlightPhoto>()

  public registerMeta(meta: PhotoMetaPayload): boolean {
    if (meta.totalChunks < 1 || meta.totalChunks > MAX_TOTAL_CHUNKS) {
      return false
    }
    if (this.inFlight.has(meta.id)) {
      return false
    }
    this.inFlight.set(meta.id, {
      id: meta.id,
      totalChunks: meta.totalChunks,
      receivedCount: 0,
      receivedIndices: new Set<number>(),
      chunks: new Array(meta.totalChunks).fill(null),
      ttlSeconds: meta.ttlSeconds,
      mimeType: meta.mimeType || 'image/webp',
    })
    return true
  }

  public addChunk(
    id: string,
    chunkIndex: number,
    data: Uint8Array
  ): { photo?: ReceivedPhoto; progress?: { received: number; total: number } } | null {
    const photo = this.inFlight.get(id)
    if (!photo) {
      return null
    }

    if (chunkIndex < 0 || chunkIndex >= photo.totalChunks) {
      return null
    }

    // Ignore duplicate chunks
    if (photo.receivedIndices.has(chunkIndex)) {
      return {
        progress: { received: photo.receivedCount, total: photo.totalChunks },
      }
    }

    photo.receivedIndices.add(chunkIndex)
    photo.chunks[chunkIndex] = data
    photo.receivedCount++

    if (photo.receivedCount === photo.totalChunks) {
      const assembled = reassembleChunks(photo.chunks)
      // Wipe temporary intermediate chunk buffers
      for (const c of photo.chunks) {
        if (c) wipeBytes(c)
      }
      this.inFlight.delete(id)
      return {
        photo: {
          id: photo.id,
          data: assembled,
          mimeType: photo.mimeType,
          ttlSeconds: photo.ttlSeconds,
        },
      }
    }

    return {
      progress: { received: photo.receivedCount, total: photo.totalChunks },
    }
  }

  public clear(): void {
    for (const photo of this.inFlight.values()) {
      for (const c of photo.chunks) {
        if (c) wipeBytes(c)
      }
    }
    this.inFlight.clear()
  }
}

/**
 * GhostTunnelWebRTC handles the end-to-end P2P session with serialized atomic sends,
 * backpressure management, sequence AAD validation, and memory-safe cleanup.
 */
export class GhostTunnelWebRTC {
  public pc: RTCPeerConnection | null = null
  public dc: RTCDataChannel | null = null
  private txKey: Uint8Array
  private rxKey: Uint8Array
  private txSeq = 0
  private rxSeq = 0
  private sendQueue: Promise<void> = Promise.resolve()
  private photoAssembler = new PhotoAssembler()
  private listeners: ((event: TunnelEvent) => void)[] = []

  constructor(sessionKeys: DirectionalSessionKeys) {
    this.txKey = new Uint8Array(sessionKeys.sharedTx)
    this.rxKey = new Uint8Array(sessionKeys.sharedRx)
  }

  public onEvent(callback: (event: TunnelEvent) => void): () => void {
    this.listeners.push(callback)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== callback)
    }
  }

  private emit(event: TunnelEvent) {
    for (const l of this.listeners) {
      try {
        l(event)
      } catch (err) {
        console.error('Error in tunnel listener:', err)
      }
    }
  }

  /**
   * Initializes RTCPeerConnection with the given ICE configuration.
   */
  public initPeerConnection(mode: IceMode, turnConfig?: TurnConfig): RTCPeerConnection {
    const iceServers = getIceServers(mode, turnConfig)
    this.pc = new RTCPeerConnection({ iceServers })

    this.pc.ondatachannel = (event) => {
      this.attachDataChannel(event.channel)
    }

    this.pc.onconnectionstatechange = () => {
      if (
        this.pc?.connectionState === 'disconnected' ||
        this.pc?.connectionState === 'failed' ||
        this.pc?.connectionState === 'closed'
      ) {
        this.emit({ type: 'close' })
      }
    }

    return this.pc
  }

  /**
   * Creates and attaches a DataChannel on the Host peer.
   */
  public createDataChannel(label = 'ghost-tunnel'): RTCDataChannel {
    if (!this.pc) {
      throw new Error('PeerConnection not initialized')
    }
    const dc = this.pc.createDataChannel(label, { ordered: true })
    this.attachDataChannel(dc)
    return dc
  }

  /**
   * Binds binary message listeners to the RTCDataChannel.
   */
  public attachDataChannel(dc: RTCDataChannel): void {
    this.dc = dc
    this.dc.binaryType = 'arraybuffer'

    this.dc.onmessage = (event: MessageEvent) => {
      try {
        const rawFrame = new Uint8Array(event.data as ArrayBuffer)
        const decrypted = decryptDataFrame(rawFrame, this.rxKey, this.rxSeq)
        this.rxSeq++

        const decoded = decodePacket(decrypted)
        wipeBytes(decrypted)

        if (decoded.type === 'JSON') {
          const payload = decoded.payload
          if (payload.type === 'TEXT') {
            this.emit({ type: 'message', message: payload })
          } else if (payload.type === 'PHOTO_META') {
            const accepted = this.photoAssembler.registerMeta(payload)
            if (accepted) {
              this.emit({
                type: 'photo_progress',
                id: payload.id,
                received: 0,
                total: payload.totalChunks,
              })
            }
          } else if (payload.type === 'BURN_ACK') {
            this.emit({ type: 'burn_ack', id: payload.id })
          }
        } else if (decoded.type === 'CHUNK') {
          const result = this.photoAssembler.addChunk(
            decoded.id,
            decoded.chunkIndex,
            decoded.data
          )
          if (result?.progress) {
            this.emit({
              type: 'photo_progress',
              id: decoded.id,
              received: result.progress.received,
              total: result.progress.total,
            })
          }
          if (result?.photo) {
            this.emit({ type: 'photo', photo: result.photo })
          }
        }
      } catch (err) {
        this.emit({
          type: 'error',
          error: err instanceof Error ? err : new Error(String(err)),
        })
      }
    }

    this.dc.onclose = () => {
      this.emit({ type: 'close' })
    }
  }

  /**
   * Backpressure helper: pauses until dc.bufferedAmount drains below threshold.
   */
  private async waitForBufferDrain(): Promise<void> {
    if (!this.dc || this.dc.bufferedAmount <= BUFFERED_AMOUNT_HIGH_THRESHOLD) {
      return
    }

    return new Promise<void>((resolve) => {
      const dc = this.dc!
      let resolved = false

      const cleanup = () => {
        if (!resolved) {
          resolved = true
          dc.removeEventListener('bufferedamountlow', onLow)
          clearInterval(interval)
          resolve()
        }
      }

      const onLow = () => cleanup()
      dc.bufferedAmountLowThreshold = 65536 // 64 KB
      dc.addEventListener('bufferedamountlow', onLow)

      const interval = setInterval(() => {
        if (!this.dc || this.dc.bufferedAmount <= BUFFERED_AMOUNT_HIGH_THRESHOLD) {
          cleanup()
        }
      }, 40)
    })
  }

  /**
   * Serialized send helper: txSeq assignment, encryption, and dc.send execute
   * synchronously together after any backpressure drain, preventing out-of-order sequence frames.
   */
  public sendRawPacket(packet: Uint8Array): Promise<void> {
    const executeSend = async () => {
      await this.waitForBufferDrain()
      if (!this.dc || this.dc.readyState !== 'open') {
        throw new Error('DataChannel is not open')
      }
      const seq = this.txSeq++
      const frame = encryptDataFrame(packet, this.txKey, seq)
      this.dc.send(frame as unknown as ArrayBufferView<ArrayBuffer>)
    }

    this.sendQueue = this.sendQueue.then(executeSend, executeSend)
    return this.sendQueue
  }

  /**
   * Sends an ephemeral text message.
   */
  public async sendTextMessage(text: string, ttlSeconds = 15): Promise<string> {
    const id = generateUUID()
    const payload: TextMessagePayload = { type: 'TEXT', id, text, ttlSeconds }
    const packet = encodeJsonPacket(payload)
    await this.sendRawPacket(packet)
    return id
  }

  /**
   * Sends a BURN_ACK receipt.
   */
  public async sendBurnAck(id: string): Promise<void> {
    const payload: BurnAckPayload = { type: 'BURN_ACK', id }
    const packet = encodeJsonPacket(payload)
    await this.sendRawPacket(packet)
  }

  /**
   * Slices, encrypts, and transmits a sanitized photo in 16,000-byte chunks.
   * Wipes outgoing image bytes immediately after queuing.
   */
  public async sendPhoto(
    sanitized: SanitizedImage,
    ttlSeconds = 6
  ): Promise<string> {
    const id = generateUUID()
    const slices = sliceIntoChunks(sanitized.data, MAX_CHUNK_SLICE_BYTES)
    const totalChunks = slices.length

    if (totalChunks < 1 || totalChunks > MAX_TOTAL_CHUNKS) {
      wipeBytes(sanitized.data)
      throw new Error(`Photo size exceeds allowed limit (1 to ${MAX_TOTAL_CHUNKS} chunks)`)
    }

    try {
      // 1. Send PHOTO_META
      const metaPayload: PhotoMetaPayload = {
        type: 'PHOTO_META',
        id,
        totalChunks,
        ttlSeconds,
        mimeType: sanitized.mimeType,
      }
      const metaPacket = encodeJsonPacket(metaPayload)
      await this.sendRawPacket(metaPacket)

      // 2. Send each CHUNK
      for (let i = 0; i < totalChunks; i++) {
        const chunkPacket = encodeChunkPacket(i, id, slices[i])
        await this.sendRawPacket(chunkPacket)
      }

      return id
    } finally {
      // Immediate sender-side memory wipe of raw image bytes
      wipeBytes(sanitized.data)
      for (const s of slices) {
        wipeBytes(s)
      }
    }
  }

  /**
   * Destroys the WebRTC session, closes connections, and wipes volatile keys and buffers.
   */
  public closeSession(): void {
    if (this.dc) {
      try {
        this.dc.close()
      } catch {}
      this.dc = null
    }

    if (this.pc) {
      try {
        this.pc.close()
      } catch {}
      this.pc = null
    }

    wipeBytes(this.txKey)
    wipeBytes(this.rxKey)
    this.photoAssembler.clear()
    this.listeners = []
  }
}
