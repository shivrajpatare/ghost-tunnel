# GhostTunnel Security, Privacy & Engineering Policies

## 1. Zero-Persistence Data Policy
- No server, database, object store, or analytics endpoint may receive user messages, photos, passkeys, or peer identities.
- Client code in `src/` must never invoke `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie`, `caches`, or register a Service Worker.
- Build outputs (`dist/`) must disable source maps (`sourcemap: false`) to minimize reverse-engineering metadata in production bundles.

## 2. Threat Model Boundaries

### Defended Against
- Third-party interception (ISP, public Wi-Fi, hosting provider, or messaging app used to transport the `GT1.` handshake token).
- Unauthorized access to the tunnel without both the Shared Access Passkey and mutual token approval.
- Passive device forensics via browser cache, IndexedDB, localStorage, or lingering `blob:` URLs.
- EXIF/GPS location leakage embedded in camera photos.
- Packet tampering or replay attacks over the DataChannel.

### Explicitly Out of Scope (Accepted Limits)
- Compromised endpoint OS, keyloggers, malicious browser extensions with active DOM/canvas read permissions, or rooted devices.
- Physical capture of the receiver's display using a second camera or OS-level screen recorder.
- Traffic-analysis IP visibility between directly connected peers (inherent to direct P2P WebRTC unless routed via VPN or TURN).

## 3. Dependency & Network Hygiene Policy
- Zero external runtime assets: no Google Fonts, no external CDN scripts, no remote QR code APIs.
- Strict Content Security Policy in `public/_headers`:
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self';`
  (Note: WebRTC ICE/UDP operates outside `connect-src` in standard browsers; keep `connect-src 'none'` to block accidental `fetch()` or `WebSocket` leaks.)
- Every newly added npm package must be audited for telemetry or network calls before merging.

## 4. Pre-Release Verification Gate
No deployment to Cloudflare Pages is permitted until `/security-audit` reports `PASS` on all five checks:
1. Static grep confirms zero forbidden storage APIs in `src/`.
2. `public/_headers` passes header and CSP validation.
3. `npx tsc --noEmit` exits with code 0.
4. `npx vitest run` passes 100% of crypto and chunking test cases.
5. `npm run build` succeeds with zero `.map` files in `dist/`.
