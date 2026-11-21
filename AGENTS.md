# GhostTunnel Project Contract

## Product Goal
Serverless, zero-persistence, peer-to-peer ephemeral photo and chat web app.
No backend database, no signaling server, and no client-side disk persistence.

## Tech Stack
- Build: Vite + React 19 + TypeScript (strict mode) + Tailwind CSS v4
- Crypto: libsodium-wrappers-sumo (Argon2id, X25519 KX, XChaCha20-Poly1305, memzero)
- Transport: Native browser WebRTC RTCDataChannel (ordered binary frames)
- Testing: Vitest + jsdom
- Hosting: Static bundle on Cloudflare Pages (with public/_headers)

## Engineering Standards
- Work incrementally: Crypto Core -> WebRTC & Chunker -> UI & Canvas -> Security Audit -> Deploy.
- Every protocol module in src/lib/ must have a matching Vitest suite in tests/.
- Never install backend frameworks, analytics SDKs, external font CDNs, or service workers.

## Reference Documentation
Read the relevant file in `docs/` before planning or refactoring:
- `docs/PRD.md` for feature scope, user flows, and strict non-goals.
- `docs/TECHNICAL_RD.md` for wire formats, crypto primitives, and NAT constraints.
- `docs/DECISIONS.md` before changing any library, protocol, or storage pattern.
- `docs/POLICIES.md` for zero-persistence, threat-model, and release rules.
