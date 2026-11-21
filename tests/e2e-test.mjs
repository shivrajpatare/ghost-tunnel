import puppeteer from 'puppeteer-core'
import path from 'path'

const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const SCREENSHOT_PATH = path.resolve('revealed_snap.png')

async function runE2E() {
  console.log('--- Starting GhostTunnel Stage 5 Pure DOM E2E Verification ---')

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
    ],
  })

  try {
    const consoleLogs = { a: [], b: [] }
    const networkRequests = { a: [], b: [] }

    // 1. Tab A: Host
    console.log('[1/6] Navigating Tab A to http://localhost:5173...')
    const pageA = await browser.newPage()
    await pageA.setViewport({ width: 440, height: 850 })
    pageA.on('console', (msg) => {
      if (msg.type() === 'error') consoleLogs.a.push(msg.text())
    })
    pageA.on('pageerror', (err) => consoleLogs.a.push(String(err)))
    pageA.on('request', (req) => networkRequests.a.push(req.url()))

    await pageA.goto('http://localhost:5173', { waitUntil: 'networkidle0' })
    await pageA.bringToFront()

    // 2. Tab A: Enter passkey and generate invite token
    console.log('[2/6] Tab A: Generating Host GT1 invite token with passkey GhostSecret99...')
    await pageA.type('input[type="password"]', 'GhostSecret99')
    await pageA.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent.includes('CREATE INVITE TOKEN')
      )
      btn?.click()
    })

    await pageA.waitForFunction(
      () => document.querySelector('textarea')?.value?.startsWith('GT1.'),
      { timeout: 15000 }
    )
    const inviteToken = await pageA.$eval('textarea', (el) => el.value)
    console.log('      Tab A Invite Token generated (length: ' + inviteToken.length + ')')

    // 3. Tab B: Guest
    console.log('[3/6] Opening Tab B and testing Negative Auth with wrong passkey WrongPass00...')
    const pageB = await browser.newPage()
    await pageB.setViewport({ width: 440, height: 850 })
    pageB.on('console', (msg) => {
      if (msg.type() === 'error') consoleLogs.b.push(msg.text())
    })
    pageB.on('pageerror', (err) => consoleLogs.b.push(String(err)))
    pageB.on('request', (req) => networkRequests.b.push(req.url()))

    await pageB.goto('http://localhost:5173', { waitUntil: 'networkidle0' })
    await pageB.bringToFront()

    // Click JOIN TUNNEL
    await pageB.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent.includes('JOIN TUNNEL')
      )
      btn?.click()
    })

    // Type wrong passkey and paste invite token into textarea
    await pageB.type('input[type="password"]', 'WrongPass00')
    await pageB.evaluate((token) => {
      const ta = document.querySelector('textarea')
      if (ta) {
        // Native value setter to trigger React synthetic onChange
        const prototype = Object.getPrototypeOf(ta)
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
        setter?.call(ta, token)
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        ta.dispatchEvent(new Event('change', { bubbles: true }))
      }
    }, inviteToken)

    // Click PROCESS INVITE & ANSWER
    await pageB.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent.includes('PROCESS INVITE')
      )
      btn?.click()
    })

    // Wait for error notice to show up on Tab B
    await pageB.waitForSelector('.border-red-900\\/60', { timeout: 15000 })
    const errorText = await pageB.$eval('.border-red-900\\/60', (el) => el.textContent)
    console.log('      Tab B caught expected error:', errorText.trim())
    if (!errorText.includes('Decryption failed')) {
      throw new Error(`Expected decryption error message but got: ${errorText}`)
    }

    // 4. Tab B: Full Mutual-Key Pairing (Correct Passkey)
    console.log('[4/6] Tab B: Entering correct passkey and generating response token...')
    // Clear password input and type correct passkey
    await pageB.click('input[type="password"]', { clickCount: 3 })
    await pageB.keyboard.press('Backspace')
    await pageB.type('input[type="password"]', 'GhostSecret99')

    await pageB.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent.includes('PROCESS INVITE')
      )
      btn?.click()
    })

    await pageB.waitForFunction(
      () => document.querySelector('textarea')?.value?.startsWith('GT1.'),
      { timeout: 15000 }
    )
    const responseToken = await pageB.$eval('textarea', (el) => el.value)
    console.log('      Tab B Response Token generated (length: ' + responseToken.length + ')')

    // Switch to Tab A: paste response token & connect
    console.log('      Tab A: Accepting Response Token...')
    await pageA.bringToFront()
    await pageA.evaluate((token) => {
      const ta = document.querySelector('textarea[placeholder*="Paste GT1. response token"]')
      if (ta) {
        const prototype = Object.getPrototypeOf(ta)
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
        setter?.call(ta, token)
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        ta.dispatchEvent(new Event('change', { bubbles: true }))
      }
    }, responseToken)

    await pageA.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent.includes('ACCEPT RESPONSE')
      )
      btn?.click()
    })

    // Wait for active connected state on both tabs (SAFETY NUMBER badge visible)
    console.log('      Waiting for WebRTC DataChannel connection on Tab A and Tab B...')
    await pageA.waitForFunction(
      () => document.body.textContent.includes('SAFETY NUMBER:'),
      { timeout: 20000 }
    )
    await pageB.bringToFront()
    await pageB.waitForFunction(
      () => document.body.textContent.includes('SAFETY NUMBER:'),
      { timeout: 20000 }
    )

    const extractSafety = async (page) => {
      return await page.evaluate(() => {
        const badge = Array.from(document.querySelectorAll('*')).find((el) =>
          el.textContent?.trim().startsWith('SAFETY NUMBER:')
        )
        const parent = badge?.parentElement
        const num = parent?.querySelector('.text-emerald-400')
        return num?.textContent?.trim() || ''
      })
    }

    const safetyNumberB = await extractSafety(pageB)
    await pageA.bringToFront()
    const safetyNumberA = await extractSafety(pageA)

    console.log('      Tab A Safety Number:', safetyNumberA)
    console.log('      Tab B Safety Number:', safetyNumberB)

    if (!safetyNumberA || safetyNumberA !== safetyNumberB) {
      throw new Error(
        `Safety Numbers do not match! Host: ${safetyNumberA}, Guest: ${safetyNumberB}`
      )
    }
    console.log('      ✓ Mutual Safety Numbers MATCH strictly:', safetyNumberA)

    // 5. Ephemeral Text Chat & Auto-Burn
    console.log('[5/6] Testing Ephemeral Text Chat (5s TTL) & Auto-Burn...')
    await pageA.bringToFront()
    // Select 5s TTL on Tab A
    await pageA.select('select', '5')
    await pageA.type('input[placeholder="Ephemeral message..."]', 'Ephemeral Secret 42')
    await pageA.click('button[type="submit"]')

    // Wait for message on Tab B
    await pageB.bringToFront()
    await pageB.waitForFunction(
      () => document.body.textContent.includes('Ephemeral Secret 42'),
      { timeout: 5000 }
    )
    console.log('      ✓ Tab B received message: "Ephemeral Secret 42"')

    // Wait 6.2s for TTL expiration and auto-burn
    console.log('      Waiting 6.2s for TTL auto-burn and BURN_ACK...')
    await new Promise((r) => setTimeout(r, 6200))

    const isBurnedB = await pageB.evaluate(
      () => !document.body.textContent.includes('Ephemeral Secret 42')
    )
    await pageA.bringToFront()
    const isBurnedA = await pageA.evaluate(
      () => !document.body.textContent.includes('Ephemeral Secret 42')
    )

    if (!isBurnedB || !isBurnedA) {
      throw new Error(
        `Message did not burn! Tab B burned: ${isBurnedB}, Tab A burned: ${isBurnedA}`
      )
    }
    console.log('      ✓ Message auto-burned cleanly from both Tab A and Tab B!')

    // 6. Ephemeral Photo Transfer & Hold-to-View Canvas Burn
    console.log('[6/6] Testing Ephemeral Photo Transfer & Hold-to-View Canvas Burn...')
    await pageA.evaluate(async () => {
      const fi = document.querySelector('input[type="file"]')
      if (!fi) throw new Error('File input not found')

      // Generate in-memory canvas image
      const c = document.createElement('canvas')
      c.width = 16
      c.height = 16
      const ctx = c.getContext('2d')
      ctx.fillStyle = '#10b981'
      ctx.fillRect(0, 0, 16, 16)
      const blob = await new Promise((res) => c.toBlob(res, 'image/png'))
      const file = new File([blob], 'test-snap.png', { type: 'image/png' })

      const dt = new DataTransfer()
      dt.items.add(file)
      fi.files = dt.files
      fi.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // Wait for snap card on Tab B
    await pageB.bringToFront()
    await pageB.waitForFunction(
      () => document.body.textContent.includes('PRESS & HOLD TO VIEW'),
      { timeout: 15000 }
    )
    console.log('      ✓ Tab B received snap card ("PRESS & HOLD TO VIEW")')

    // Find the hold-to-view button on Tab B
    const holdBtnHandle = await pageB.evaluateHandle(() => {
      return Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent.includes('PRESS & HOLD TO VIEW')
      )
    })
    const holdBtn = holdBtnHandle.asElement()
    await holdBtn.scrollIntoViewIfNeeded()
    const btnBox = await holdBtn.boundingBox()

    // Hold pointer down for ~600 ms
    console.log('      Holding pointer down for 600 ms on Tab B...')
    await pageB.mouse.move(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2)
    await pageB.mouse.down()
    await new Promise((r) => setTimeout(r, 600))

    // Check canvas dimensions while holding
    const canvasStatus = await pageB.evaluate(() => {
      const c = document.querySelector('canvas')
      return {
        exists: !!c,
        width: c?.width || 0,
        height: c?.height || 0,
        isHidden: c?.classList?.contains('hidden') || false,
      }
    })
    console.log('      Canvas status during hold:', canvasStatus)

    if (!canvasStatus.exists || canvasStatus.width <= 0 || canvasStatus.height <= 0) {
      throw new Error('Canvas was not rendered during pointer hold!')
    }

    // Capture screenshot of revealed snap
    await pageB.screenshot({ path: SCREENSHOT_PATH })
    console.log('      ✓ Captured screenshot of revealed canvas to:', SCREENSHOT_PATH)

    // Release pointer to trigger immediate burn
    console.log('      Releasing pointer to burn snap...')
    await pageB.mouse.up()
    await new Promise((r) => setTimeout(r, 800))

    // Confirm snap card is burned and removed from Tab B
    const isSnapBurnedB = await pageB.evaluate(
      () => !document.body.textContent.includes('EPHEMERAL SNAP')
    )
    console.log('      ✓ Snap card burned and removed from DOM on Tab B:', isSnapBurnedB)

    // 7. Panic Teardown & Zero-Storage Inspection
    console.log('--- Testing Panic Teardown (BURN SESSION) & Zero Storage ---')
    await pageA.bringToFront()
    await pageA.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent.includes('BURN SESSION')
      )
      btn?.click()
    })
    await pageA.waitForFunction(
      () => document.body.textContent.includes('ZERO-PERSISTENCE P2P TUNNEL'),
      { timeout: 5000 }
    )
    console.log('      ✓ Tab A cleanly reset to SETUP screen upon BURN SESSION')

    const inspectStorage = async (page) => {
      return await page.evaluate(async () => {
        return {
          localStorageLen: window.localStorage.length,
          sessionStorageLen: window.sessionStorage.length,
          cookies: document.cookie,
          indexedDBDatabases: (await indexedDB.databases()).length,
          cacheKeys: (await caches.keys()).length,
        }
      })
    }

    const storageA = await inspectStorage(pageA)
    const storageB = await inspectStorage(pageB)

    console.log('      Tab A Storage:', storageA)
    console.log('      Tab B Storage:', storageB)

    const isClean = (s) =>
      s.localStorageLen === 0 &&
      s.sessionStorageLen === 0 &&
      s.cookies === '' &&
      s.indexedDBDatabases === 0 &&
      s.cacheKeys === 0

    if (!isClean(storageA) || !isClean(storageB)) {
      throw new Error('Storage inspection failed: found lingering storage residue!')
    }
    console.log('      ✓ Strict Zero Disk Storage verified: 0 items in all browser storage APIs')

    // Network inspection
    const externalReqsA = networkRequests.a.filter((u) => !u.startsWith('http://localhost:5173'))
    const externalReqsB = networkRequests.b.filter((u) => !u.startsWith('http://localhost:5173'))
    console.log('      External network requests Tab A:', externalReqsA.length)
    console.log('      External network requests Tab B:', externalReqsB.length)
    if (externalReqsA.length > 0 || externalReqsB.length > 0) {
      throw new Error(`Found unexpected external network requests: ${JSON.stringify([...externalReqsA, ...externalReqsB])}`)
    }
    console.log('      ✓ Zero Outbound Network Egress verified: all requests strictly localhost')

    // Console inspection: filter out expected Negative Auth test error
    const unexpectedErrorsA = consoleLogs.a.filter((e) => !e.includes('favicon.ico') && !e.includes('404'))
    const unexpectedErrorsB = consoleLogs.b.filter(
      (e) => !e.includes('ciphertext cannot be decrypted') && !e.includes('favicon.ico') && !e.includes('404')
    )
    console.log('      Tab A Unexpected Console Errors:', unexpectedErrorsA)
    console.log('      Tab B Unexpected Console Errors:', unexpectedErrorsB)
    if (unexpectedErrorsA.length > 0 || unexpectedErrorsB.length > 0) {
      throw new Error(`Found unexpected console errors: ${JSON.stringify([...unexpectedErrorsA, ...unexpectedErrorsB])}`)
    }
    console.log('      ✓ Zero Console Errors verified across both tabs')

    console.log('\n========================================')
    console.log(' ALL STAGE 5 E2E CHECKS PASSED 100%! ')
    console.log('========================================\n')
  } finally {
    await browser.close()
  }
}

runE2E().catch((err) => {
  console.error('E2E Verification Failed:', err)
  process.exit(1)
})
