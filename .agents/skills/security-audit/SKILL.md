---
name: security-audit
description: Audits GhostTunnel for forbidden storage APIs, memory leaks, missing CSP headers, failing crypto tests, and clean production builds. Use before releases or after major changes.
---

# GhostTunnel Pre-Release Security Audit

Execute these checks in order and report a pass/fail table:

1. Search `src/` for forbidden persistence APIs: `localStorage`, `sessionStorage`, `indexedDB`, `createObjectURL`, `document.cookie`, and `serviceWorker`. Fail if any match exists.
2. Verify `public/_headers` contains `Cache-Control: no-store`, `Clear-Site-Data`, and a strict `Content-Security-Policy` with `wasm-unsafe-eval` and no external script domains.
3. Run `npx tsc --noEmit` to confirm zero TypeScript errors.
4. Run `npx vitest run` to confirm all cryptography and chunking tests pass.
5. Run `npm run build` and verify no `.map` source maps are emitted in `dist/`.
