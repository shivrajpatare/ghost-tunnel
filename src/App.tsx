import { useState, useRef, useEffect, useCallback } from 'react'
import {
  sealHandshakeToken,
  openHandshakeToken,
  generateEphemeralKeyPair,
  deriveHostSessionKeys,
  deriveGuestSessionKeys,
  calculateSafetyNumber,
  wipeBytes,
  toBase64Url,
  fromBase64Url,
  EphemeralKeyPair,
  DirectionalSessionKeys,
} from './lib/crypto'
import {
  GhostTunnelWebRTC,
  IceMode,
  TurnConfig,
  waitForIceGathering,
  sanitizeImage,
} from './lib/webrtc'
import HoldToViewSnap, { SnapItem } from './components/HoldToViewSnap'
import QrModal from './components/QrModal'
import QrScanner from './components/QrScanner'
import NetworkDrawer from './components/NetworkDrawer'

type AppStep =
  | 'SETUP'
  | 'HOST_OFFER_READY'
  | 'GUEST_ANSWER_READY'
  | 'CONNECTING'
  | 'CONNECTED'

interface ChatMessage {
  id: string
  text: string
  sender: 'me' | 'peer'
  ttlSeconds: number
  expiresAt: number
}

export default function App() {
  // Navigation / Handshake state
  const [step, setStep] = useState<AppStep>('SETUP')
  const [role, setRole] = useState<'host' | 'guest'>('host')
  const [passkey, setPasskey] = useState('')
  const [errorNotice, setErrorNotice] = useState<string | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)

  // Tokens
  const [inviteToken, setInviteToken] = useState('')
  const [responseToken, setResponseToken] = useState('')
  const [inputToken, setInputToken] = useState('')

  // Safety Number & Network
  const [safetyNumber, setSafetyNumber] = useState<string | null>(null)
  const [iceMode, setIceMode] = useState<IceMode>('stun-p2p')
  const [turnConfig, setTurnConfig] = useState<TurnConfig>({ url: '', username: '', credential: '' })

  // Modals
  const [isQrModalOpen, setIsQrModalOpen] = useState(false)
  const [qrModalToken, setQrModalToken] = useState('')
  const [qrModalTitle, setQrModalTitle] = useState('')
  const [isQrScannerOpen, setIsQrScannerOpen] = useState(false)
  const [isNetworkDrawerOpen, setIsNetworkDrawerOpen] = useState(false)

  // Ephemeral Room Data (Volatile RAM only)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [inputText, setInputText] = useState('')
  const [messageTtl, setMessageTtl] = useState(15)
  const [snaps, setSnaps] = useState<SnapItem[]>([])
  const [photoTtl, setPhotoTtl] = useState(6)
  const [photoProgress, setPhotoProgress] = useState<{ id: string; received: number; total: number } | null>(null)

  // Refs for WebRTC instance, ephemeral keys, and timers
  const tunnelRef = useRef<GhostTunnelWebRTC | null>(null)
  const hostKeyPairRef = useRef<EphemeralKeyPair | null>(null)
  const guestKeyPairRef = useRef<EphemeralKeyPair | null>(null)
  const sessionKeysRef = useRef<DirectionalSessionKeys | null>(null)
  const activeTimersRef = useRef<Map<string, number>>(new Map())
  const snapsRef = useRef<SnapItem[]>([])
  snapsRef.current = snaps

  // Panic Wipe: destroys all keys, stops connections, flushes timers, zeroes buffers
  const burnSession = useCallback(() => {
    // 1. Clear all active message auto-burn timers
    for (const timerId of activeTimersRef.current.values()) {
      clearTimeout(timerId)
    }
    activeTimersRef.current.clear()

    // 2. Wipe memory of any unviewed snaps in state
    for (const snap of snapsRef.current) {
      wipeBytes(snap.bytes)
    }

    // 3. Close and wipe WebRTC session
    if (tunnelRef.current) {
      tunnelRef.current.closeSession()
      tunnelRef.current = null
    }

    // 4. Wipe keys
    if (hostKeyPairRef.current) {
      wipeBytes(hostKeyPairRef.current.privateKey)
      hostKeyPairRef.current = null
    }
    if (guestKeyPairRef.current) {
      wipeBytes(guestKeyPairRef.current.privateKey)
      guestKeyPairRef.current = null
    }
    if (sessionKeysRef.current) {
      wipeBytes(sessionKeysRef.current.sharedTx)
      wipeBytes(sessionKeysRef.current.sharedRx)
      sessionKeysRef.current = null
    }

    // 5. Reset React state
    setStep('SETUP')
    setPasskey('')
    setInviteToken('')
    setResponseToken('')
    setInputToken('')
    setSafetyNumber(null)
    setMessages([])
    setSnaps([])
    setInputText('')
    setPhotoProgress(null)
    setErrorNotice(null)
  }, [])

  useEffect(() => {
    const handleBeforeUnload = () => {
      burnSession()
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      burnSession()
    }
  }, [burnSession])

  // Setup listeners on WebRTC Tunnel
  const attachTunnelListeners = useCallback(
    (tunnel: GhostTunnelWebRTC) => {
      tunnel.onEvent((event) => {
        if (event.type === 'message') {
          const msg = event.message
          const expiresAt = Date.now() + msg.ttlSeconds * 1000
          setMessages((prev) => [
            ...prev,
            { id: msg.id, text: msg.text, sender: 'peer', ttlSeconds: msg.ttlSeconds, expiresAt },
          ])

          // Schedule auto-burn
          const timerId = window.setTimeout(() => {
            setMessages((prev) => prev.filter((m) => m.id !== msg.id))
            activeTimersRef.current.delete(msg.id)
            tunnelRef.current?.sendBurnAck(msg.id).catch(() => {})
          }, msg.ttlSeconds * 1000)

          activeTimersRef.current.set(msg.id, timerId)
        } else if (event.type === 'photo') {
          const photo = event.photo
          setSnaps((prev) => [
            ...prev,
            {
              id: photo.id,
              bytes: photo.data,
              mimeType: photo.mimeType,
              ttlSeconds: photo.ttlSeconds,
              receivedAt: Date.now(),
            },
          ])
          setPhotoProgress(null)
        } else if (event.type === 'photo_progress') {
          setPhotoProgress({ id: event.id, received: event.received, total: event.total })
        } else if (event.type === 'burn_ack') {
          // Peer burned our sent message or snap
          setMessages((prev) => prev.filter((m) => m.id !== event.id))
        } else if (event.type === 'close') {
          burnSession()
        } else if (event.type === 'error') {
          setErrorNotice(`Connection error: ${event.error.message}`)
        }
      })
    },
    [burnSession]
  )

  // Step 1 (Host): Generate Invite Token
  const handleHostStart = async () => {
    if (passkey.length < 6) {
      setErrorNotice('Passkey must be at least 6 characters.')
      return
    }
    setErrorNotice(null)
    setIsProcessing(true)

    try {
      const keyPair = await generateEphemeralKeyPair()
      hostKeyPairRef.current = keyPair

      const tempKeys: DirectionalSessionKeys = {
        sharedRx: new Uint8Array(32),
        sharedTx: new Uint8Array(32),
      }
      const tunnel = new GhostTunnelWebRTC(tempKeys)
      tunnelRef.current = tunnel
      attachTunnelListeners(tunnel)

      const pc = tunnel.initPeerConnection(iceMode, turnConfig)
      const dc = tunnel.createDataChannel('ghost-snap')

      dc.onopen = () => {
        setStep('CONNECTED')
      }

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      await waitForIceGathering(pc, 3500)

      const localSdp = pc.localDescription?.sdp || ''
      const hostPubB64 = await toBase64Url(keyPair.publicKey)

      const token = await sealHandshakeToken(
        { role: 'host', sdp: localSdp, pubKey: hostPubB64 },
        passkey
      )

      setInviteToken(token)
      setStep('HOST_OFFER_READY')
    } catch (err) {
      console.error(err)
      setErrorNotice('Failed to generate invite token. Check network settings.')
    } finally {
      setIsProcessing(false)
    }
  }

  // Step 2 (Guest): Process Invite & Generate Response Token
  const handleGuestProcessInvite = async (tokenToUse?: string, passkeyToUse?: string) => {
    const rawToken = tokenToUse || inputToken
    const keyToUse = passkeyToUse || passkey
    if (!rawToken.trim()) {
      setErrorNotice('Please paste or scan a valid GT1. token.')
      return
    }
    if (keyToUse.length < 6) {
      setErrorNotice('Passkey must be at least 6 characters.')
      return
    }
    setErrorNotice(null)
    setIsProcessing(true)

    try {
      const payload = await openHandshakeToken(rawToken.trim(), keyToUse)
      if (payload.role !== 'host') {
        throw new Error('Expected a Host Invite token')
      }

      const hostPub = await fromBase64Url(payload.pubKey)

      const guestKeyPair = await generateEphemeralKeyPair()
      guestKeyPairRef.current = guestKeyPair

      const sessionKeys = await deriveGuestSessionKeys(guestKeyPair, hostPub)
      sessionKeysRef.current = sessionKeys

      const safety = calculateSafetyNumber(hostPub, guestKeyPair.publicKey)
      setSafetyNumber(safety)

      const tunnel = new GhostTunnelWebRTC(sessionKeys)
      tunnelRef.current = tunnel
      attachTunnelListeners(tunnel)

      const pc = tunnel.initPeerConnection(iceMode, turnConfig)

      pc.ondatachannel = (e) => {
        tunnel.attachDataChannel(e.channel)
        e.channel.onopen = () => {
          setStep('CONNECTED')
        }
      }

      await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp })
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      await waitForIceGathering(pc, 3500)

      const localSdp = pc.localDescription?.sdp || ''
      const guestPubB64 = await toBase64Url(guestKeyPair.publicKey)

      const responseTokenStr = await sealHandshakeToken(
        { role: 'guest', sdp: localSdp, pubKey: guestPubB64 },
        keyToUse
      )

      setResponseToken(responseTokenStr)
      setStep('GUEST_ANSWER_READY')
    } catch (err) {
      console.error(err)
      setErrorNotice(
        'Decryption failed. Ensure the passkey is identical and the token was not truncated.'
      )
    } finally {
      setIsProcessing(false)
    }
  }

  // Step 3 (Host): Accept Response Token
  const handleHostAcceptResponse = async (tokenToUse?: string, passkeyToUse?: string) => {
    const rawToken = tokenToUse || inputToken
    const keyToUse = passkeyToUse || passkey
    if (!rawToken.trim()) {
      setErrorNotice('Please paste or scan a valid GT1. response token.')
      return
    }
    setErrorNotice(null)
    setIsProcessing(true)

    try {
      const payload = await openHandshakeToken(rawToken.trim(), keyToUse)
      if (payload.role !== 'guest') {
        throw new Error('Expected a Guest Response token')
      }

      const guestPub = await fromBase64Url(payload.pubKey)

      const hostKeyPair = hostKeyPairRef.current
      if (!hostKeyPair) {
        throw new Error('Host ephemeral keys missing')
      }

      const sessionKeys = await deriveHostSessionKeys(hostKeyPair, guestPub)
      sessionKeysRef.current = sessionKeys

      const safety = calculateSafetyNumber(hostKeyPair.publicKey, guestPub)
      setSafetyNumber(safety)

      const tunnel = tunnelRef.current
      if (!tunnel || !tunnel.pc) {
        throw new Error('Tunnel PeerConnection not initialized')
      }

      // Re-initialize directional keys on the tunnel instance
      ;(tunnel as any).txKey = new Uint8Array(sessionKeys.sharedTx)
      ;(tunnel as any).rxKey = new Uint8Array(sessionKeys.sharedRx)

      await tunnel.pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp })

      if (tunnel.dc?.readyState === 'open') {
        setStep('CONNECTED')
      } else {
        setStep('CONNECTING')
        tunnel.dc?.addEventListener('open', () => {
          setStep('CONNECTED')
        })
      }
    } catch (err) {
      console.error(err)
      setErrorNotice(
        'Failed to decrypt response token. Verify the passkey and token completeness.'
      )
    } finally {
      setIsProcessing(false)
    }
  }

  // Sending Chat
  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!inputText.trim() || !tunnelRef.current) return
    const text = inputText.trim()
    setInputText('')

    try {
      const id = await tunnelRef.current.sendTextMessage(text, messageTtl)
      const expiresAt = Date.now() + messageTtl * 1000
      setMessages((prev) => [
        ...prev,
        { id, text, sender: 'me', ttlSeconds: messageTtl, expiresAt },
      ])

      // Auto-burn on sender view too
      const timerId = window.setTimeout(() => {
        setMessages((prev) => prev.filter((m) => m.id !== id))
        activeTimersRef.current.delete(id)
      }, messageTtl * 1000)

      activeTimersRef.current.set(id, timerId)
    } catch (err) {
      console.error('Failed to send text message:', err)
      setErrorNotice('Message send failed. Channel may be disconnected.')
    }
  }

  // Sending Photo
  const handlePhotoSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !tunnelRef.current) return
    e.target.value = '' // Clear input immediately

    try {
      setIsProcessing(true)
      const sanitized = await sanitizeImage(file, 1440)
      await tunnelRef.current.sendPhoto(sanitized, photoTtl)
    } catch (err) {
      console.error('Failed to send photo:', err)
      setErrorNotice('Photo transmission failed.')
    } finally {
      setIsProcessing(false)
    }
  }

  // Handling Snap Burn on Receiver
  const handleBurnSnap = useCallback(
    (id: string) => {
      setSnaps((prev) => prev.filter((s) => s.id !== id))
      tunnelRef.current?.sendBurnAck(id).catch(() => {})
    },
    []
  )

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 font-sans text-zinc-100 antialiased select-none">
      {/* Top Navbar */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-zinc-800/80 bg-zinc-950/80 px-4 py-3 backdrop-blur-md">
        <div className="flex items-center gap-2.5">
          <div className="h-3 w-3 rounded-full bg-emerald-500 animate-pulse" />
          <span className="font-mono text-sm font-bold tracking-wider text-zinc-100">
            GHOST<span className="text-emerald-400">TUNNEL</span>
          </span>
          <span className="rounded-full border border-zinc-800 bg-zinc-900 px-2 py-0.5 font-mono text-[10px] text-zinc-400">
            v1.0 RAM
          </span>
        </div>

        <div className="flex items-center gap-2">
          {step === 'CONNECTED' ? (
            <button
              onClick={burnSession}
              className="flex items-center gap-1.5 rounded-lg border border-red-500/40 bg-red-950/40 px-3 py-1.5 font-mono text-xs font-semibold text-red-400 hover:bg-red-900/60 transition-colors"
            >
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              BURN SESSION
            </button>
          ) : (
            <button
              onClick={() => setIsNetworkDrawerOpen(true)}
              className="rounded-lg border border-zinc-800 bg-zinc-900 p-2 text-zinc-400 hover:text-zinc-200 transition-colors"
              title="Network Settings"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
          )}
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 flex flex-col max-w-lg mx-auto w-full p-4">
        {errorNotice && (
          <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-red-900/60 bg-red-950/40 p-3.5 text-xs text-red-200">
            <svg className="h-4 w-4 shrink-0 text-red-400 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div className="flex-1 font-mono">{errorNotice}</div>
            <button onClick={() => setErrorNotice(null)} className="text-red-400 hover:text-red-200">
              ✕
            </button>
          </div>
        )}

        {/* ================= STEP: SETUP ================= */}
        {step === 'SETUP' && (
          <div className="space-y-6 my-auto">
            <div className="text-center space-y-1">
              <h2 className="font-mono text-lg font-bold text-zinc-100">
                ZERO-PERSISTENCE P2P TUNNEL
              </h2>
              <p className="text-xs text-zinc-500 font-mono">
                Direct in-memory ephemeral chat & snaps. No server, no disk storage.
              </p>
            </div>

            {/* Role Picker */}
            <div className="grid grid-cols-2 gap-2 rounded-xl border border-zinc-800 bg-zinc-900/50 p-1">
              <button
                type="button"
                onClick={() => setRole('host')}
                className={`py-2 rounded-lg font-mono text-xs font-semibold uppercase tracking-wider transition-all ${
                  role === 'host'
                    ? 'bg-zinc-800 text-emerald-400 shadow'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                HOST TUNNEL
              </button>
              <button
                type="button"
                onClick={() => setRole('guest')}
                className={`py-2 rounded-lg font-mono text-xs font-semibold uppercase tracking-wider transition-all ${
                  role === 'guest'
                    ? 'bg-zinc-800 text-emerald-400 shadow'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                JOIN TUNNEL
              </button>
            </div>

            {/* Passkey Input */}
            <div className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
              <label className="block font-mono text-xs font-semibold uppercase tracking-wider text-zinc-300">
                1. SHARED ACCESS PASSKEY
              </label>
              <input
                type="password"
                value={passkey}
                onChange={(e) => setPasskey(e.target.value)}
                placeholder="Enter shared secret (min 6 chars)..."
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3.5 py-2.5 font-mono text-sm text-zinc-100 placeholder-zinc-700 focus:border-emerald-500 focus:outline-none"
              />
              <p className="text-[11px] text-zinc-500 font-mono">
                Agreed upon out-of-band. Derives the 32-byte Argon2id token key.
              </p>
            </div>

            {role === 'host' ? (
              <button
                type="button"
                disabled={passkey.length < 6 || isProcessing}
                onClick={handleHostStart}
                className="w-full py-3 px-4 rounded-xl font-mono text-xs font-bold uppercase tracking-wider bg-emerald-500 text-black hover:bg-emerald-400 disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-lg shadow-emerald-500/10"
              >
                {isProcessing ? 'GATHERING ICE CANDIDATES...' : 'CREATE INVITE TOKEN →'}
              </button>
            ) : (
              <div className="space-y-3">
                <div className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                  <div className="flex items-center justify-between">
                    <label className="block font-mono text-xs font-semibold uppercase tracking-wider text-zinc-300">
                      2. PASTE HOST INVITE TOKEN
                    </label>
                    <button
                      type="button"
                      onClick={() => setIsQrScannerOpen(true)}
                      className="font-mono text-[11px] text-emerald-400 hover:underline flex items-center gap-1"
                    >
                      📷 SCAN QR
                    </button>
                  </div>
                  <textarea
                    value={inputToken}
                    onChange={(e) => setInputToken(e.target.value)}
                    placeholder="GT1.ey..."
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    rows={3}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950 p-2.5 font-mono text-xs text-zinc-100 placeholder-zinc-700 focus:border-emerald-500 focus:outline-none"
                  />
                </div>
                <button
                  type="button"
                  disabled={passkey.length < 6 || !inputToken.trim() || isProcessing}
                  onClick={() => handleGuestProcessInvite()}
                  className="w-full py-3 px-4 rounded-xl font-mono text-xs font-bold uppercase tracking-wider bg-emerald-500 text-black hover:bg-emerald-400 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                >
                  {isProcessing ? 'DECRYPTING & NEGOTIATING...' : 'PROCESS INVITE & ANSWER →'}
                </button>
              </div>
            )}
          </div>
        )}

        {/* ================= STEP: HOST_OFFER_READY ================= */}
        {step === 'HOST_OFFER_READY' && (
          <div className="space-y-5 my-auto">
            <div className="text-center space-y-1">
              <h2 className="font-mono text-sm font-bold text-emerald-400">
                STEP 2: SHARE INVITE TOKEN
              </h2>
              <p className="text-xs text-zinc-400 font-mono">
                Send this passkey-encrypted token to your guest.
              </p>
            </div>

            <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
              <textarea
                readOnly
                value={inviteToken}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                rows={4}
                className="w-full rounded-lg border border-zinc-800 bg-zinc-950 p-2.5 font-mono text-[11px] text-zinc-300 select-all"
              />
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(inviteToken)
                    setErrorNotice('Invite token copied to clipboard!')
                    setTimeout(() => setErrorNotice(null), 2500)
                  }}
                  className="py-2.5 rounded-lg border border-zinc-700 bg-zinc-800 font-mono text-xs font-semibold text-zinc-200 hover:bg-zinc-700 transition-colors"
                >
                  COPY TOKEN
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setQrModalToken(inviteToken)
                    setQrModalTitle('HOST INVITE TOKEN')
                    setIsQrModalOpen(true)
                  }}
                  className="py-2.5 rounded-lg border border-emerald-500/30 bg-emerald-950/40 font-mono text-xs font-semibold text-emerald-400 hover:bg-emerald-900/50 transition-colors"
                >
                  SHOW QR CODE
                </button>
              </div>
            </div>

            <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
              <div className="flex items-center justify-between">
                <label className="block font-mono text-xs font-semibold uppercase tracking-wider text-zinc-300">
                  STEP 3: PASTE GUEST RESPONSE TOKEN
                </label>
                <button
                  type="button"
                  onClick={() => setIsQrScannerOpen(true)}
                  className="font-mono text-[11px] text-emerald-400 hover:underline flex items-center gap-1"
                >
                  📷 SCAN QR
                </button>
              </div>
              <textarea
                value={inputToken}
                onChange={(e) => setInputToken(e.target.value)}
                placeholder="Paste GT1. response token from guest..."
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                rows={3}
                className="w-full rounded-lg border border-zinc-800 bg-zinc-950 p-2.5 font-mono text-xs text-zinc-100 placeholder-zinc-700 focus:border-emerald-500 focus:outline-none"
              />
              <button
                type="button"
                disabled={!inputToken.trim() || isProcessing}
                onClick={() => handleHostAcceptResponse()}
                className="w-full py-3 rounded-xl font-mono text-xs font-bold uppercase tracking-wider bg-emerald-500 text-black hover:bg-emerald-400 disabled:opacity-40 transition-all"
              >
                {isProcessing ? 'ESTABLISHING P2P...' : 'ACCEPT RESPONSE & CONNECT →'}
              </button>
            </div>
          </div>
        )}

        {/* ================= STEP: GUEST_ANSWER_READY ================= */}
        {step === 'GUEST_ANSWER_READY' && (
          <div className="space-y-5 my-auto">
            <div className="text-center space-y-1">
              <h2 className="font-mono text-sm font-bold text-emerald-400">
                STEP 3: SEND RESPONSE TOKEN TO HOST
              </h2>
              <p className="text-xs text-zinc-400 font-mono">
                Give this token back to the Host to complete the handshake.
              </p>
            </div>

            {safetyNumber && (
              <div className="flex items-center justify-between rounded-xl border border-emerald-900/40 bg-emerald-950/20 px-4 py-3">
                <span className="font-mono text-xs text-zinc-400">SAFETY NUMBER:</span>
                <span className="font-mono text-base font-bold tracking-widest text-emerald-400">
                  {safetyNumber}
                </span>
              </div>
            )}

            <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
              <textarea
                readOnly
                value={responseToken}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                rows={4}
                className="w-full rounded-lg border border-zinc-800 bg-zinc-950 p-2.5 font-mono text-[11px] text-zinc-300 select-all"
              />
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(responseToken)
                    setErrorNotice('Response token copied to clipboard!')
                    setTimeout(() => setErrorNotice(null), 2500)
                  }}
                  className="py-2.5 rounded-lg border border-zinc-700 bg-zinc-800 font-mono text-xs font-semibold text-zinc-200 hover:bg-zinc-700 transition-colors"
                >
                  COPY TOKEN
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setQrModalToken(responseToken)
                    setQrModalTitle('GUEST RESPONSE TOKEN')
                    setIsQrModalOpen(true)
                  }}
                  className="py-2.5 rounded-lg border border-emerald-500/30 bg-emerald-950/40 font-mono text-xs font-semibold text-emerald-400 hover:bg-emerald-900/50 transition-colors"
                >
                  SHOW QR CODE
                </button>
              </div>
            </div>

            <div className="flex items-center justify-center gap-2 text-zinc-500 font-mono text-xs">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-500 animate-ping" />
              Waiting for Host to accept and open DataChannel...
            </div>
          </div>
        )}

        {/* ================= STEP: CONNECTING ================= */}
        {step === 'CONNECTING' && (
          <div className="flex flex-col items-center justify-center space-y-3 my-auto">
            <div className="h-10 w-10 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
            <div className="font-mono text-sm font-semibold text-zinc-200">
              OPENING P2P DATACHANNEL...
            </div>
            <p className="font-mono text-xs text-zinc-500">
              Performing ICE candidate checks & DTLS session negotiation.
            </p>
          </div>
        )}

        {/* ================= STEP: CONNECTED (Active Room) ================= */}
        {step === 'CONNECTED' && (
          <div className="flex-1 flex flex-col justify-between">
            {/* Safety Verification Badge */}
            {safetyNumber && (
              <div className="mb-3 flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/60 px-3.5 py-2">
                <div className="flex items-center gap-2 font-mono text-xs text-zinc-400">
                  <span className="h-2 w-2 rounded-full bg-emerald-400" />
                  SAFETY NUMBER:
                </div>
                <div className="font-mono text-sm font-bold tracking-widest text-emerald-400">
                  {safetyNumber}
                </div>
              </div>
            )}

            {/* Photo Transfer In-Flight Progress */}
            {photoProgress && (
              <div className="mb-3 rounded-lg border border-amber-900/50 bg-amber-950/30 p-2.5 text-xs font-mono text-amber-200">
                Receiving photo chunk {photoProgress.received} of {photoProgress.total}...
              </div>
            )}

            {/* Snaps Container */}
            {snaps.length > 0 && (
              <div className="mb-4 space-y-2">
                {snaps.map((snap) => (
                  <HoldToViewSnap key={snap.id} snap={snap} onBurn={handleBurnSnap} />
                ))}
              </div>
            )}

            {/* Message Feed */}
            <div className="flex-1 space-y-2 overflow-y-auto pr-1">
              {messages.length === 0 && snaps.length === 0 && (
                <div className="flex flex-col items-center justify-center h-48 text-center text-zinc-600 font-mono text-xs">
                  <svg className="h-8 w-8 mb-2 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                  Tunnel active. Messages and snaps self-destruct upon viewing.
                </div>
              )}

              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex flex-col ${
                    msg.sender === 'me' ? 'items-end' : 'items-start'
                  }`}
                >
                  <div
                    className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm ${
                      msg.sender === 'me'
                        ? 'bg-emerald-500 text-black font-medium'
                        : 'bg-zinc-800 text-zinc-100 font-normal border border-zinc-700/50'
                    }`}
                  >
                    {msg.text}
                  </div>
                  <span className="mt-0.5 px-1 font-mono text-[10px] text-zinc-500">
                    TTL {msg.ttlSeconds}s
                  </span>
                </div>
              ))}
            </div>

            {/* Compose Controls */}
            <div className="mt-4 pt-3 border-t border-zinc-800">
              <div className="flex items-center justify-between mb-2 px-1">
                <div className="flex items-center gap-1 font-mono text-[11px] text-zinc-400">
                  <span>TTL:</span>
                  <select
                    value={messageTtl}
                    onChange={(e) => setMessageTtl(Number(e.target.value))}
                    className="rounded bg-zinc-900 border border-zinc-800 px-1 py-0.5 text-zinc-200 text-xs focus:outline-none"
                  >
                    <option value={5}>5s</option>
                    <option value={15}>15s</option>
                    <option value={30}>30s</option>
                  </select>
                </div>

                <div className="flex items-center gap-1 font-mono text-[11px] text-zinc-400">
                  <span>SNAP TIMER:</span>
                  <select
                    value={photoTtl}
                    onChange={(e) => setPhotoTtl(Number(e.target.value))}
                    className="rounded bg-zinc-900 border border-zinc-800 px-1 py-0.5 text-zinc-200 text-xs focus:outline-none"
                  >
                    <option value={3}>3s</option>
                    <option value={6}>6s</option>
                    <option value={10}>10s</option>
                  </select>
                </div>
              </div>

              <form onSubmit={handleSendMessage} className="flex gap-2">
                <label
                  className="flex items-center justify-center px-3 py-2.5 rounded-xl border border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-emerald-400 hover:border-zinc-700 cursor-pointer transition-colors"
                  title="Send Photo"
                >
                  <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handlePhotoSelect}
                    className="hidden"
                  />
                </label>

                <input
                  type="text"
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  placeholder="Ephemeral message..."
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  className="flex-1 rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 focus:border-emerald-500 focus:outline-none"
                />

                <button
                  type="submit"
                  disabled={!inputText.trim()}
                  className="px-4 py-2.5 rounded-xl font-mono text-xs font-bold uppercase tracking-wider bg-emerald-500 text-black hover:bg-emerald-400 disabled:opacity-40 transition-all"
                >
                  SEND
                </button>
              </form>
            </div>
          </div>
        )}
      </main>

      {/* Offline QR Code Modal */}
      <QrModal
        isOpen={isQrModalOpen}
        onClose={() => setIsQrModalOpen(false)}
        token={qrModalToken}
        title={qrModalTitle}
      />

      {/* Offline QR Scanner Modal */}
      <QrScanner
        isOpen={isQrScannerOpen}
        onClose={() => setIsQrScannerOpen(false)}
        onScan={(scannedToken) => {
          if (step === 'SETUP' && role === 'guest') {
            setInputToken(scannedToken)
            handleGuestProcessInvite(scannedToken)
          } else if (step === 'HOST_OFFER_READY') {
            setInputToken(scannedToken)
            handleHostAcceptResponse(scannedToken)
          }
        }}
      />

      {/* Network & NAT Drawer */}
      <NetworkDrawer
        isOpen={isNetworkDrawerOpen}
        onClose={() => setIsNetworkDrawerOpen(false)}
        mode={iceMode}
        onModeChange={setIceMode}
        turnConfig={turnConfig}
        onTurnConfigChange={setTurnConfig}
        isConnected={step === 'CONNECTED'}
      />
    </div>
  )
}
