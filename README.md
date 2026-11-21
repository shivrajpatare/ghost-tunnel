# 👻 GhostTunnel

Serverless, zero-persistence, peer-to-peer ephemeral photo and chat web app. Volatile RAM only: no central database, no persistent signaling server, and zero client-side disk caching.

---

## 🔒 Security & Architecture Invariants

- **Zero Disk Persistence:** No calls to `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie`, or Cache API.
- **Mutual End-to-End Cryptography:**
  - **Key Derivation:** Argon2id (`crypto_pwhash`) derives a 32-byte key from a shared passkey to seal out-of-band `GT1.` tokens with Deflate compression.
  - **Key Exchange:** Ephemeral X25519 key exchange establishes forward-secret directional keys (`sharedTx` / `sharedRx`).
  - **Frame Encryption:** Every WebRTC DataChannel packet is sealed with `XChaCha20-Poly1305` using a 4-byte big-endian monotonically increasing sequence counter as Associated Data (AAD) to prevent replay and out-of-order injection.
- **Canvas-Only Visual Pipeline:** Decrypted photos are never injected into DOM `<img>` elements or `URL.createObjectURL()`. They decode directly via `createImageBitmap()` into an HTML5 `<canvas>` strictly while the user holds down the pointer.
- **Immediate Memory Zeroing:** Media buffers, chunk slices, and session keys are wiped in RAM via `sodium.memzero()` immediately after transmission, viewing, or session termination.
- **EXIF Stripping:** All outgoing photos are re-encoded through an offscreen canvas (WebP, max 1440px) to strip GPS and camera metadata before chunking.
- **Anti-Leak Defense:** Window blur, tab switch (`visibilitychange`), or screenshot shortcut triggers an immediate blanking of the canvas and volatile memory wipe.

---

## 🛠️ Tech Stack

- **Framework:** Vite + React 19 + TypeScript (strict mode) + Tailwind CSS v4
- **Cryptography:** `libsodium-wrappers-sumo` (WASM)
- **Transport:** Native browser WebRTC `RTCDataChannel` (ordered binary frames)
- **Testing:** Vitest + jsdom + Puppeteer dual-tab E2E runner
- **Hosting:** Cloudflare Pages (with strict `_headers`)

---

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Local Development
```bash
npm run dev
```
Open `http://localhost:5173`.

### 3. Run Protocol & Cryptography Tests
```bash
npx vitest run
```
Runs 16 unit tests across `tests/crypto.test.ts` and `tests/chunker.test.ts`.

### 4. Run Automated Dual-Tab E2E Verification
```bash
# Requires local Chrome installed at default path
node tests/e2e-test.mjs
```
Automates two browser tabs testing negative auth rejection, mutual handshake, safety number verification, 5s TTL text auto-burn, hold-to-view canvas rendering, panic session wipe, and 0-storage verification.

### 5. Pre-Release Security Audit
Run the automated audit script:
```bash
# 1. Check for forbidden storage APIs in src/
Select-String -Path (Get-ChildItem -Path src -Recurse -File).FullName -Pattern "localStorage|sessionStorage|indexedDB|createObjectURL|document\.cookie|serviceWorker"

# 2. Type check
npx tsc --noEmit

# 3. Unit tests
npx vitest run

# 4. Production build (verifies no .map files emitted)
npm run build
Get-ChildItem -Path dist -Recurse -Filter "*.map"
```

---

## ☁️ Cloudflare Pages Deployment

### 1. Connect Repository
1. Push this repository to a private GitHub or GitLab repository.
2. In the [Cloudflare Dashboard](https://dash.cloudflare.com/), go to **Workers & Pages** -> **Create application** -> **Pages** -> **Connect to Git**.
3. Select the repository and configure build settings:
   - **Framework preset:** `Vite` (or `None`)
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
4. Click **Save and Deploy**. Cloudflare automatically applies `dist/_headers` on every request.

### 2. Verify Live Headers
Verify strict caching and CSP headers on your deployed domain:
```bash
curl -I https://your-project.pages.dev
```
Expected response headers:
```http
Cache-Control: no-store, no-cache, must-revalidate, max-age=0
Pragma: no-cache
Clear-Site-Data: "cache", "storage"
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' data:;
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
```

### 3. Local Emulator Test with Wrangler
Test the built `dist/` bundle with real Cloudflare Pages header enforcement locally:
```bash
npx wrangler pages dev dist
```
Navigate to `http://localhost:8788`, verify zero CSP violations in DevTools Console, and confirm token creation works.

---

## 🛡️ Cloudflare Zero Trust (Email OTP Access Gate)

To ensure GhostTunnel remains invite-only without modifying application code:

1. In the Cloudflare Zero Trust dashboard, navigate to **Access** -> **Applications**.
2. Click **Add an application** -> **Self-hosted**.
3. Set the application name (e.g., `GhostTunnel`) and enter your Pages domain (`your-project.pages.dev`).
4. Under **Policies**, create an **Allow** rule:
   - **Action:** Allow
   - **Include Rule:** Emails / Email domain (enter the authorized email addresses of yourself and your trusted invitees).
5. Under **Identity providers**, enable **One-time PIN (OTP)**.
6. Save the application. Anyone visiting the site must now enter a one-time passcode sent to an authorized email before the static assets load.

---

## 🌐 Custom Coturn Setup (Optional TURN Relay)

If peers are both behind restrictive cellular symmetric NATs (e.g., 4G/5G mobile carriers) where direct STUN P2P fails:

1. Deploy Coturn on a cheap VPS using Docker:
```bash
docker run -d --net=host \
  --name=coturn \
  coturn/coturn \
  -n \
  --log-file=stdout \
  --realm=turn.yourdomain.com \
  --listening-port=3478 \
  --tls-listening-port=5349 \
  --user=tunneluser:SecretTurnPassword123 \
  --no-stdout-log
```
2. Open the **NETWORK** drawer in the GhostTunnel app.
3. Switch connection profile to **CUSTOM TURN**, enter:
   - **URL:** `turn:turn.yourdomain.com:3478`
   - **Username:** `tunneluser`
   - **Credential:** `SecretTurnPassword123`
4. Generate the invite token. The TURN configuration will be included in the token negotiation.
