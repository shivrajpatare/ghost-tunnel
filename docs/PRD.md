# GhostTunnel Product Requirements Document (PRD)

## 1. Objective
Build a static, web-based, invite-only peer-to-peer (P2P) application for ephemeral photo sharing and short text chat. All communication occurs directly between two mutually authenticated devices in volatile RAM with zero central database, zero persistent signaling server, and zero disk caching.

## 2. Target Users & Usage Context
- Personal use between a small circle of explicitly invited participants.
- Works across mobile browsers (iOS Safari, Android Chrome) and desktop browsers (Chrome, Firefox, Edge) without requiring an app store install.
- Supports both remote pairing (copy-paste encrypted text tokens over any existing messenger) and in-person pairing (offline QR codes).

## 3. Core Functional Requirements

### 3.1 Mutual-Key Handshake (Access Control)
- Both peers must enter an out-of-band Shared Access Passkey (minimum 6 characters).
- Host generates a passkey-encrypted, compressed Invite Token (`GT1.<base64url>`) containing the WebRTC Offer SDP and an ephemeral X25519 public key.
- Guest decrypts the Invite Token with the same passkey, approves the pairing, and produces an encrypted Response Token (`GT1.<base64url>`).
- Host decrypts and approves the Response Token to open the direct P2P channel.
- Both peers display a deterministic 6-digit Safety Number derived from both public keys so they can verify no man-in-the-middle tampered with the exchange.

### 3.2 Ephemeral Messaging & Snaps
- Text messages auto-delete from the receiver's view after a configurable TTL (default 15s) and trigger a `BURN_ACK` receipt back to the sender.
- Photos are stripped of EXIF and GPS metadata on the sender's device before encryption and transmission.
- Received photos are never rendered in `<img>` tags or downloadable URLs. The receiver must press and hold to render the photo onto an HTML5 `<canvas>` for a set timer (3s, 6s, or 10s).
- Releasing the hold, timer expiration, tab switch (`visibilitychange`), window blur, or screenshot shortcut (`PrintScreen` / `Cmd+Shift`) immediately blanks the canvas, zeros RAM buffers, removes the item from state, and sends `BURN_ACK`.

### 3.3 Session Controls & Network Modes
- One-tap **Burn Session** button immediately destroys keys, closes the WebRTC connection, and clears all UI state.
- User-selectable NAT traversal modes in a collapsible Network drawer:
  1. `zero-server`: Empty ICE servers (strictly local Wi-Fi / LAN).
  2. `stun-p2p` (default): Public STUN for NAT address discovery; direct P2P media transit.
  3. `custom-turn`: User-supplied self-hosted Coturn credentials for strict 4G/5G symmetric NAT fallback.

## 4. Strict Non-Goals (Out of Scope)
- No user accounts, phone numbers, email logins, or contact lists inside the app.
- No server-side message queuing or offline delivery (both peers must be online simultaneously).
- No chat history, backups, media galleries, or message editing.
- No group chats (strictly 1-to-1 tunnel per session).
- No analytics, crash reporting SDKs, cookies, or third-party CDNs.

## 5. Acceptance Criteria (v1.0)
- Two separate browser tabs/devices complete pairing and exchange a text message and a photo end-to-end.
- Entering an incorrect passkey or modifying any character of a `GT1.` token fails decryption cleanly without exposing partial data.
- DevTools Application storage (LocalStorage, SessionStorage, IndexedDB, Cookies, Cache Storage) remains completely empty during and after a session.
- HTTP response headers on the deployed build include `Cache-Control: no-store` and `Clear-Site-Data: "cache", "storage"`.
