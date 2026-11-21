import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'

interface QrModalProps {
  isOpen: boolean
  onClose: () => void
  token: string
  title: string
}

export default function QrModal({ isOpen, onClose, token, title }: QrModalProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [qrOverflow, setQrOverflow] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!isOpen || !token) return

    setQrOverflow(false)
    setCopied(false)

    // Short timeout to ensure canvas is attached in DOM
    const timer = setTimeout(() => {
      if (!canvasRef.current) return
      QRCode.toCanvas(canvasRef.current, token, {
        errorCorrectionLevel: 'L', // Maximize QR capacity for SDP
        width: 280,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#ffffff',
        },
      }).catch((err) => {
        console.warn('Token exceeds QR byte capacity:', err)
        setQrOverflow(true)
      })
    }, 50)

    return () => clearTimeout(timer)
  }, [isOpen, token])

  if (!isOpen) return null

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(token)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy token:', err)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="relative w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl">
        <div className="flex items-center justify-between pb-4 border-b border-zinc-800">
          <h3 className="font-mono text-sm font-semibold uppercase tracking-wider text-emerald-400">
            {title}
          </h3>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-100 transition-colors"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="my-5 flex flex-col items-center justify-center">
          {qrOverflow ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-amber-900/50 bg-amber-950/30 p-6 text-center">
              <svg className="h-8 w-8 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <p className="font-mono text-xs text-amber-200">
                Token size exceeds QR capacity due to multi-network ICE candidates.
              </p>
              <p className="text-[11px] text-zinc-400">
                Please use the Copy Token button below.
              </p>
            </div>
          ) : (
            <div className="rounded-xl bg-white p-3 shadow-inner">
              <canvas ref={canvasRef} className="block rounded" />
            </div>
          )}
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleCopy}
            className={`flex-1 py-2.5 px-4 rounded-lg font-mono text-xs font-semibold uppercase tracking-wider transition-colors ${
              copied
                ? 'bg-emerald-500 text-black'
                : 'bg-zinc-800 text-zinc-100 hover:bg-zinc-700'
            }`}
          >
            {copied ? 'COPIED TO CLIPBOARD!' : 'COPY TOKEN'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="py-2.5 px-4 rounded-lg font-mono text-xs font-semibold uppercase tracking-wider bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 transition-colors"
          >
            CLOSE
          </button>
        </div>
      </div>
    </div>
  )
}
