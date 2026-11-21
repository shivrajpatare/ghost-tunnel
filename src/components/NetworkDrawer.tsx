import { IceMode, TurnConfig } from '../lib/webrtc'

interface NetworkDrawerProps {
  isOpen: boolean
  onClose: () => void
  mode: IceMode
  onModeChange: (mode: IceMode) => void
  turnConfig: TurnConfig
  onTurnConfigChange: (config: TurnConfig) => void
  isConnected: boolean
}

export default function NetworkDrawer({
  isOpen,
  onClose,
  mode,
  onModeChange,
  turnConfig,
  onTurnConfigChange,
  isConnected,
}: NetworkDrawerProps) {
  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/60 backdrop-blur-sm">
      <div className="relative h-full w-full max-w-sm border-l border-zinc-800 bg-zinc-950 p-6 shadow-2xl flex flex-col justify-between">
        <div>
          <div className="flex items-center justify-between pb-4 border-b border-zinc-800">
            <div className="flex items-center gap-2">
              <svg className="h-5 w-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
              </svg>
              <h3 className="font-mono text-sm font-semibold uppercase tracking-wider text-zinc-100">
                NETWORK & NAT SETTINGS
              </h3>
            </div>
            <button
              onClick={onClose}
              className="text-zinc-400 hover:text-zinc-100 transition-colors"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {isConnected && (
            <div className="mt-4 rounded-lg border border-amber-900/40 bg-amber-950/20 p-3 font-mono text-xs text-amber-300">
              Tunnel is active. Network settings apply to new sessions.
            </div>
          )}

          <div className="mt-6 space-y-4">
            <div>
              <label className="block font-mono text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-2">
                ICE TRAVERSAL MODE
              </label>
              <div className="space-y-2">
                <label
                  className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                    mode === 'stun-p2p'
                      ? 'border-emerald-500 bg-emerald-950/20'
                      : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700'
                  } ${isConnected ? 'opacity-60 cursor-not-allowed' : ''}`}
                >
                  <input
                    type="radio"
                    name="iceMode"
                    value="stun-p2p"
                    checked={mode === 'stun-p2p'}
                    disabled={isConnected}
                    onChange={() => onModeChange('stun-p2p')}
                    className="mt-1 text-emerald-500"
                  />
                  <div>
                    <div className="font-mono text-xs font-semibold text-zinc-200">
                      STUN P2P (Default)
                    </div>
                    <div className="text-[11px] text-zinc-500">
                      Uses public Google STUN for NAT discovery; all media traverses direct P2P.
                    </div>
                  </div>
                </label>

                <label
                  className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                    mode === 'zero-server'
                      ? 'border-emerald-500 bg-emerald-950/20'
                      : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700'
                  } ${isConnected ? 'opacity-60 cursor-not-allowed' : ''}`}
                >
                  <input
                    type="radio"
                    name="iceMode"
                    value="zero-server"
                    checked={mode === 'zero-server'}
                    disabled={isConnected}
                    onChange={() => onModeChange('zero-server')}
                    className="mt-1 text-emerald-500"
                  />
                  <div>
                    <div className="font-mono text-xs font-semibold text-zinc-200">
                      Zero-Server (LAN Only)
                    </div>
                    <div className="text-[11px] text-zinc-500">
                      Empty ICE servers. Strictly local Wi-Fi or ad-hoc LAN network.
                    </div>
                  </div>
                </label>

                <label
                  className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                    mode === 'custom-turn'
                      ? 'border-emerald-500 bg-emerald-950/20'
                      : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700'
                  } ${isConnected ? 'opacity-60 cursor-not-allowed' : ''}`}
                >
                  <input
                    type="radio"
                    name="iceMode"
                    value="custom-turn"
                    checked={mode === 'custom-turn'}
                    disabled={isConnected}
                    onChange={() => onModeChange('custom-turn')}
                    className="mt-1 text-emerald-500"
                  />
                  <div>
                    <div className="font-mono text-xs font-semibold text-zinc-200">
                      Custom TURN Relay
                    </div>
                    <div className="text-[11px] text-zinc-500">
                      Self-hosted Coturn credentials for strict 4G/5G carrier NAT fallback.
                    </div>
                  </div>
                </label>
              </div>
            </div>

            {mode === 'custom-turn' && (
              <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                <div className="font-mono text-[11px] uppercase tracking-wider text-emerald-400">
                  COTURN SERVER CREDENTIALS
                </div>
                <div>
                  <label className="block text-[11px] font-mono text-zinc-400 mb-1">
                    TURN URL (e.g. turn:turn.domain.com:3478)
                  </label>
                  <input
                    type="text"
                    value={turnConfig.url}
                    disabled={isConnected}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    onChange={(e) =>
                      onTurnConfigChange({ ...turnConfig, url: e.target.value })
                    }
                    placeholder="turn:example.com:3478"
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950 p-2 font-mono text-xs text-zinc-200 placeholder-zinc-700 focus:border-emerald-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-mono text-zinc-400 mb-1">
                    Username
                  </label>
                  <input
                    type="text"
                    value={turnConfig.username || ''}
                    disabled={isConnected}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    onChange={(e) =>
                      onTurnConfigChange({ ...turnConfig, username: e.target.value })
                    }
                    placeholder="turnuser"
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950 p-2 font-mono text-xs text-zinc-200 placeholder-zinc-700 focus:border-emerald-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-mono text-zinc-400 mb-1">
                    Credential / Password
                  </label>
                  <input
                    type="password"
                    value={turnConfig.credential || ''}
                    disabled={isConnected}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    onChange={(e) =>
                      onTurnConfigChange({ ...turnConfig, credential: e.target.value })
                    }
                    placeholder="••••••••"
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950 p-2 font-mono text-xs text-zinc-200 placeholder-zinc-700 focus:border-emerald-500 focus:outline-none"
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="w-full py-2.5 px-4 rounded-lg font-mono text-xs font-semibold uppercase tracking-wider bg-zinc-800 text-zinc-100 hover:bg-zinc-700 transition-colors"
        >
          DONE
        </button>
      </div>
    </div>
  )
}
