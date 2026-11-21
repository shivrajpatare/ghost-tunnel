---
trigger: always_on
description: Hard zero-persistence, anti-cache, and memory-wiping invariants for GhostTunnel.
---

# Mandatory Security Invariants

1. **Zero Disk Storage:** Never call `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie`, or the Cache API anywhere in `src/`.
2. **No Downloadable Image URLs:** Never render decrypted photos with `<img>` tags or `URL.createObjectURL()`. Always decode via `createImageBitmap()` and paint onto an HTML5 `<canvas>`.
3. **Explicit Memory Zeroing:** After burning a photo, sending a photo, or closing a session, zero out all `Uint8Array` media buffers and session keys with `sodium.memzero()`, close `ImageBitmap` objects, and reset canvas dimensions to `0x0`.
4. **EXIF Stripping Required:** Every outgoing photo must be re-encoded through an offscreen canvas (`image/webp`) before chunking so GPS and camera EXIF metadata never leave the sender's device.
5. **No Outbound Telemetry:** `public/_headers` must enforce `Cache-Control: no-store` and `Clear-Site-Data: "cache", "storage"`. Do not load external scripts, QR APIs, or fonts.
