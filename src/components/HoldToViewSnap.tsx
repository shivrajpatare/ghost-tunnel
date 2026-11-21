import { useEffect, useRef, useState, useCallback } from 'react'
import { wipeBytes } from '../lib/crypto'

export interface SnapItem {
  id: string
  bytes: Uint8Array
  mimeType: string
  ttlSeconds: number
  receivedAt: number
}

interface HoldToViewSnapProps {
  snap: SnapItem
  onBurn: (id: string) => void
}

export default function HoldToViewSnap({ snap, onBurn }: HoldToViewSnapProps) {
  const [isHolding, setIsHolding] = useState(false)
  const isHoldingRef = useRef(false)
  const [timeLeft, setTimeLeft] = useState(snap.ttlSeconds)
  const burnedRef = useRef(false)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const timerRef = useRef<number | null>(null)
  const startTimeRef = useRef<number>(0)

  useEffect(() => {
    isHoldingRef.current = isHolding
  }, [isHolding])

  const burnNow = useCallback(() => {
    if (burnedRef.current) return
    burnedRef.current = true

    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }

    if (canvasRef.current) {
      const ctx = canvasRef.current.getContext('2d')
      if (ctx) {
        ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height)
      }
      canvasRef.current.width = 0
      canvasRef.current.height = 0
    }

    wipeBytes(snap.bytes)
    onBurn(snap.id)
  }, [snap.bytes, snap.id, onBurn])

  const burnNowRef = useRef(burnNow)
  useEffect(() => {
    burnNowRef.current = burnNow
  }, [burnNow])

  // Defensive security listeners: blur, tab switch, screenshot shortcuts
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden && isHoldingRef.current) {
        burnNowRef.current()
      }
    }

    const handleBlur = () => {
      if (isHoldingRef.current) {
        burnNowRef.current()
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      // PrintScreen, Cmd+Shift, Ctrl+Shift
      if (
        e.key === 'PrintScreen' ||
        (e.metaKey && e.shiftKey) ||
        (e.ctrlKey && e.shiftKey)
      ) {
        burnNowRef.current()
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('blur', handleBlur)
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('blur', handleBlur)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  const handlePointerDown = async (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!e.isPrimary || burnedRef.current) return
    e.preventDefault()

    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // Ignore if pointer capture fails
    }

    setIsHolding(true)
    startTimeRef.current = Date.now()

    // Start countdown timer
    timerRef.current = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000)
      const remaining = Math.max(0, snap.ttlSeconds - elapsed)
      setTimeLeft(remaining)
      if (remaining <= 0) {
        burnNow()
      }
    }, 100)

    try {
      // Pass snap.bytes as BlobPart with dynamic mimeType (no clone)
      const blob = new Blob([snap.bytes as BlobPart], { type: snap.mimeType })
      const bitmap = await createImageBitmap(blob)

      // Guard against fast-tap race (< 50ms tap/release)
      if (burnedRef.current) {
        bitmap.close()
        return
      }

      const canvas = canvasRef.current
      if (canvas) {
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.drawImage(bitmap, 0, 0)
        }
      }
      bitmap.close()
    } catch (err) {
      console.error('Failed to decode snap bitmap:', err)
      burnNow()
    }
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!e.isPrimary) return
    burnNow()
  }

  const handlePointerCancel = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!e.isPrimary) return
    burnNow()
  }

  const handlePointerLeave = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!e.isPrimary) return
    if (isHolding) {
      burnNow()
    }
  }

  return (
    <div className="relative my-2 rounded-xl border border-zinc-800 bg-zinc-900/80 p-3 select-none">
      <div className="flex items-center justify-between text-xs text-zinc-400 mb-2 font-mono">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
          EPHEMERAL SNAP
        </span>
        <span>{timeLeft}s remaining</span>
      </div>

      <div className="relative flex flex-col items-center justify-center overflow-hidden rounded-lg bg-zinc-950 p-2 min-h-[140px]">
        {/* HTML5 Canvas viewer: strictly memory-only */}
        <canvas
          ref={canvasRef}
          className={`max-h-[380px] max-w-full rounded object-contain transition-opacity duration-150 ${
            isHolding ? 'opacity-100' : 'hidden'
          }`}
        />

        {!isHolding && (
          <div className="flex flex-col items-center gap-2 text-center p-4">
            <svg
              className="h-8 w-8 text-amber-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
              />
            </svg>
            <p className="text-xs text-zinc-400 font-mono">
              Press and hold to reveal
              <br />
              <span className="text-zinc-600">Releasing immediately burns the snap</span>
            </p>
          </div>
        )}
      </div>

      <button
        type="button"
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onPointerLeave={handlePointerLeave}
        onContextMenu={(e) => e.preventDefault()}
        style={{ touchAction: 'none' }}
        className={`mt-3 w-full py-2.5 px-4 rounded-lg font-mono text-xs font-semibold uppercase tracking-wider transition-all active:scale-[0.98] ${
          isHolding
            ? 'bg-amber-500 text-black shadow-lg shadow-amber-500/20'
            : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'
        }`}
      >
        {isHolding ? `HOLDING (${timeLeft}s)` : 'PRESS & HOLD TO VIEW'}
      </button>
    </div>
  )
}
