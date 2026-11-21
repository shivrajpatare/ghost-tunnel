---
trigger: model_decision
description: Apply when writing or modifying cryptography, handshake tokens, WebRTC signaling, or binary photo chunking in src/lib/ or tests/.
---

# Cryptography & WebRTC Protocol Rules

- **Handshake Encryption:** Compress SDP + X25519 public key using native `CompressionStream('deflate-raw')`, derive a 32-byte key from the shared passkey via `crypto_pwhash` (Argon2id), and encrypt with `XChaCha20-Poly1305`.
- **Directional Keys:** Derive separate `sharedTx` and `sharedRx` keys via `crypto_kx_server_session_keys` (Host) and `crypto_kx_client_session_keys` (Guest). Wipe the ephemeral private key immediately after key agreement.
- **Replay Protection:** Prefix every DataChannel frame with a 4-byte big-endian sequence counter passed as AAD. Reject and drop any out-of-sequence packet.
- **Chunking:** Cap DataChannel photo frames at 16 KB and throttle when `bufferedAmount` exceeds 256 KB.
- **NAT Modes:** Support three explicit user-selectable ICE configurations: `zero-server` (empty `iceServers`), `stun-p2p`, and `custom-turn`.
