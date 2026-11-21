# GhostTunnel Technical R&D & Protocol Specification

## 1. Cryptographic Architecture

### 1.1 Handshake Sealing (`GT1.` Token)
- Input JSON: `{ role: "host" | "guest", sdp: string, pubKey: base64url(32B) }`.
- Compression: Native browser `CompressionStream('deflate-raw')` to shrink SDP payloads before encryption.
- Key Derivation: `Argon2id` (`crypto_pwhash`, `OPSLIMIT_INTERACTIVE`, `MEMLIMIT_INTERACTIVE`, 16-byte random salt) converts the user's Shared Access Passkey into a 32-byte symmetric key.
- AEAD Encryption: `XChaCha20-Poly1305` with a 24-byte random nonce.
- Wire Layout: `GT1.` + Base64URL(`[16B salt | 24B nonce | ciphertext + 16B Poly1305 tag]`).
- Derived passkey bytes are zeroed via `sodium.memzero()` immediately after sealing or opening.

### 1.2 Session Key Exchange & Forward Secrecy
- Each browser load generates a fresh ephemeral `X25519` keypair via `crypto_kx_keypair()`.
- Directional session keys are derived using `crypto_kx_server_session_keys` (Host) and `crypto_kx_client_session_keys` (Guest) so `Host.sharedTx === Guest.sharedRx` and `Host.sharedRx === Guest.sharedTx`.
- Ephemeral private keys are immediately wiped with `sodium.memzero()` once session keys are derived. Refreshing or closing the tab permanently destroys session recoverability.
- Safety Number: 6-digit decimal code derived from `BLAKE2b(hostPubKey || guestPubKey)` modulo `1,000,000`.

### 1.3 DataChannel Frame Format & Replay Protection
- WebRTC natively encrypts the `RTCDataChannel` with DTLS 1.2/1.3. GhostTunnel adds an application-layer `XChaCha20-Poly1305` envelope inside the channel so even a TURN relay only sees double-encrypted packets.
- Frame layout: `[4B big-endian sequence number | 24B random nonce | AEAD ciphertext+tag]`.
- The 4-byte sequence number is bound as Additional Authenticated Data (AAD). Receivers enforce strict monotonic progression (`seq === rxSeq`) and reject replayed, reordered, or tampered frames.

## 2. Binary Application Payloads
Decrypted plaintext packets begin with a 1-byte type tag:
- `0x01` (`PACKET_JSON`): UTF-8 JSON control or chat message:
  - `TEXT`: `{ type: "TEXT", id: uuid, text: string, ttlSeconds: number }`
  - `PHOTO_META`: `{ type: "PHOTO_META", id: uuid, totalChunks: number, ttlSeconds: number }`
  - `BURN_ACK`: `{ type: "BURN_ACK", id: uuid }`
- `0x02` (`PACKET_CHUNK`): Binary photo chunk layout:
  - `[1B tag (0x02) | 4B uint32 chunkIndex | 36B ASCII UUID | raw WebP slice]`

## 3. Media Sanitization, Chunking & Memory Lifecycle
- **EXIF Stripping:** Sender decodes the selected `File` via `createImageBitmap()`, scales it to a max dimension of `1440px`, draws onto a detached `<canvas>`, exports as `image/webp` (quality `0.82`), closes the bitmap, and clears the offscreen canvas (`width = 0; height = 0`).
- **Chunking & Backpressure:** WebP bytes are split into `16 KB` slices to remain below cross-browser SCTP message limits. Sender pauses briefly whenever `dc.bufferedAmount > 256 KB`. Sender calls `wipeBytes()` on the outgoing `Uint8Array` once queued.
- **Receiver Rendering:** Reassembled chunks form a single `Uint8Array` in JS memory (never passed to `URL.createObjectURL`). On press-and-hold, bytes are wrapped in a transient `Blob`, decoded via `createImageBitmap()`, drawn onto `<canvas>`, and the bitmap is closed immediately.
- **Destruction:** On burn trigger, canvas is cleared and collapsed to `0x0` to flush GPU backing textures, `sodium.memzero()` overwrites the `Uint8Array`, React state drops the reference, and `BURN_ACK` is transmitted.

## 4. Known Browser & Network Constraints
- **Symmetric NATs:** Simultaneous strict 4G/5G carrier NATs on both devices block direct UDP hole-punching; mitigated via optional self-hosted Coturn (`custom-turn` mode).
- **JavaScript GC Caveat:** While `Uint8Array` buffers are explicitly overwritten with zeros, transient JS strings (like typed chat text) are immutable and rely on the JS engine's garbage collector after references are dropped.
- **Analog Hole:** No browser API can physically block an external camera photographing the screen or an OS-level hardware screen recorder.
