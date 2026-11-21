import { useEffect, useRef, useState, useCallback } from 'react'

interface BarcodeDetectorInterface {
  detect(image: ImageBitmapSource): Promise<Array<{ rawValue: string }>>
}

declare global {
  interface Window {
    BarcodeDetector?: {
      new (options?: { formats: string[] }): BarcodeDetectorInterface
      getSupportedFormats?(): Promise<string[]>
    }
  }
}

interface QrScannerProps {
  isOpen: boolean
  onClose: () => void
  onScan: (token: string) => void
}

export default function QrScanner({ isOpen, onClose, onScan }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const animFrameRef = useRef<number | null>(null)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [pasteValue, setPasteValue] = useState('')

  const stopCamera = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current)
      animFrameRef.current = null
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop()
      }
      streamRef.current = null
    }
  }, [])

  const handleDetectedToken = useCallback(
    (rawToken: string) => {
      const cleanToken = rawToken.trim()
      if (cleanToken.startsWith('GT1.')) {
        stopCamera()
        onScan(cleanToken)
        onClose()
      }
    },
    [stopCamera, onScan, onClose]
  )

  useEffect(() => {
    if (!isOpen) {
      stopCamera()
      return
    }

    setCameraError(null)
    setPasteValue('')

    const hasBarcodeDetector = typeof window !== 'undefined' && 'BarcodeDetector' in window

    let isScanning = true

    const startCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false,
        })

        if (!isScanning) {
          for (const track of stream.getTracks()) track.stop()
          return
        }

        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play()
        }

        if (hasBarcodeDetector && window.BarcodeDetector) {
          const detector = new window.BarcodeDetector({ formats: ['qr_code'] })
          const scanFrame = async () => {
            if (!isScanning || !videoRef.current) return
            try {
              if (videoRef.current.readyState >= 2) {
                const barcodes = await detector.detect(videoRef.current)
                if (barcodes.length > 0) {
                  const val = barcodes[0].rawValue
                  if (val.startsWith('GT1.')) {
                    handleDetectedToken(val)
                    return
                  }
                }
              }
            } catch {
              // Frame scan error
            }
            animFrameRef.current = requestAnimationFrame(scanFrame)
          }
          animFrameRef.current = requestAnimationFrame(scanFrame)
        } else {
          setCameraError('Camera QR scan is unsupported in this browser. Please paste token below.')
        }
      } catch (err) {
        console.warn('Camera access denied or unavailable:', err)
        setCameraError('Camera access unavailable. Please paste token manually.')
      }
    }

    startCamera()

    return () => {
      isScanning = false
      stopCamera()
    }
  }, [isOpen, stopCamera, handleDetectedToken])

  if (!isOpen) return null

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (pasteValue.trim().startsWith('GT1.')) {
      handleDetectedToken(pasteValue.trim())
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="relative w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl">
        <div className="flex items-center justify-between pb-4 border-b border-zinc-800">
          <h3 className="font-mono text-sm font-semibold uppercase tracking-wider text-emerald-400">
            SCAN QR TOKEN
          </h3>
          <button
            onClick={() => {
              stopCamera()
              onClose()
            }}
            className="text-zinc-400 hover:text-zinc-100 transition-colors"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="my-4">
          {!cameraError ? (
            <div className="relative aspect-square w-full overflow-hidden rounded-xl bg-black border border-zinc-800">
              <video
                ref={videoRef}
                playsInline
                muted
                className="h-full w-full object-cover"
              />
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="h-44 w-44 rounded-lg border-2 border-dashed border-emerald-500/80 animate-pulse" />
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 text-center">
              <p className="font-mono text-xs text-zinc-400 mb-2">{cameraError}</p>
            </div>
          )}
        </div>

        {/* Fallback Paste Input */}
        <form onSubmit={handleManualSubmit} className="space-y-3">
          <div>
            <label className="block text-[11px] font-mono text-zinc-400 uppercase tracking-wider mb-1">
              OR PASTE TOKEN DIRECTLY:
            </label>
            <textarea
              value={pasteValue}
              onChange={(e) => setPasteValue(e.target.value)}
              placeholder="GT1.ey..."
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              rows={2}
              className="w-full rounded-lg border border-zinc-800 bg-zinc-950 p-2 font-mono text-xs text-zinc-200 placeholder-zinc-600 focus:border-emerald-500 focus:outline-none"
            />
          </div>

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={!pasteValue.trim().startsWith('GT1.')}
              className="flex-1 py-2.5 px-4 rounded-lg font-mono text-xs font-semibold uppercase tracking-wider bg-emerald-500 text-black hover:bg-emerald-400 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              USE TOKEN
            </button>
            <button
              type="button"
              onClick={() => {
                stopCamera()
                onClose()
              }}
              className="py-2.5 px-4 rounded-lg font-mono text-xs font-semibold uppercase tracking-wider bg-zinc-800 text-zinc-400 hover:bg-zinc-700 transition-colors"
            >
              CANCEL
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
