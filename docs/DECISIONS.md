# Architecture Decision Records (ADRs)

## ADR-001: Serverless Out-of-Band WebRTC over Central Signaling Server
- **Decision:** Exchange WebRTC Offer/Answer payloads via passkey-encrypted `GT1.` tokens / QR codes rather than running a WebSocket signaling server.
- **Rationale:** Removes backend hosting costs, server logs, IP/social-graph metadata retention, and central attack surfaces.
- **Trade-off:** Requires two copy-paste or QR scan steps to establish a session, and both peers must be online simultaneously.

## ADR-002: libsodium-wrappers-sumo over Pure WebCrypto API
- **Decision:** Use `libsodium-wrappers-sumo` (WASM) for `Argon2id`, `X25519`, `XChaCha20-Poly1305`, and `memzero`.
- **Rationale:** Browser WebCrypto lacks native `Argon2id` and `XChaCha20-Poly1305` (only PBKDF2 and AES-GCM with 96-bit nonces). XChaCha20's 192-bit nonce eliminates practical nonce-collision risk with random nonces, and Argon2id resists GPU brute-forcing on short human passkeys.
- **Trade-off:** Adds WASM bundle weight and requires `wasm-unsafe-eval` in the Content Security Policy.

## ADR-003: HTML5 Canvas + createImageBitmap over <img> and Blob URLs
- **Decision:** Render received snaps onto `<canvas>` using `createImageBitmap()` instead of `URL.createObjectURL()` and `<img>`.
- **Rationale:** Avoids exposing a reusable `blob:` URI in the DOM that users or browser extensions can easily open in a new tab or save via right-click. Allows immediate pixel flushing on pointer release or focus loss.
- **Trade-off:** Slightly higher rendering boilerplate; does not prevent OS-level screen capture.

## ADR-004: Application-Layer E2EE Inside DTLS DataChannel
- **Decision:** Encrypt every message and chunk with `XChaCha20-Poly1305` before handing it to `RTCDataChannel.send()`.
- **Rationale:** Provides defense-in-depth over WebRTC's built-in DTLS, binds cryptographic identity directly to the mutually verified Safety Number, and ensures zero plaintext exposure even if traffic routes through a TURN relay.

## ADR-005: Zero-Server Default with Optional Self-Hosted Coturn
- **Decision:** Default to STUN-assisted P2P, provide a strict `zero-server` LAN mode, and allow user-configured TURN credentials without hardcoding third-party TURN providers.
- **Rationale:** Guarantees mobile-to-mobile reliability across strict carrier NATs when needed while keeping third-party relay custody at zero by default.

## ADR-006: Static Hosting on Cloudflare Pages with Hard Anti-Cache Headers
- **Decision:** Ship as a pure static bundle with `public/_headers` enforcing `Cache-Control: no-store` and `Clear-Site-Data`.
- **Rationale:** Prevents intermediate proxies and local browser HTTP caches from retaining application snapshots, and allows optional Cloudflare Zero Trust Email OTP gating before the HTML ever loads.
