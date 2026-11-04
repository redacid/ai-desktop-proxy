// Capture the built renderer against a read-only demo API; never launches Electron or local services.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixture } from './docs-fixture.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
let playwright
if (process.env.PLAYWRIGHT_MODULE) playwright = require(process.env.PLAYWRIGHT_MODULE)
else {
  try { playwright = require('playwright') }
  catch { playwright = require(join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'playwright')) }
}
const browser = await playwright.chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', locale: 'en-GB', timezoneId: 'UTC', deviceScaleFactor: 1 })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    assert.equal(url.origin, 'http://docs.example')
    const name = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1))
    const file = resolve(root, 'out/renderer', name)
    assert.ok(file.startsWith(join(root, 'out/renderer') + '/'))
    await route.fulfill({ body: await readFile(file), contentType: { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[extname(file)] ?? 'application/octet-stream' })
  })
  await page.addInitScript((data) => {
    const off = () => () => {}
    const readOnly = () => { throw new Error('Screenshots must not run a mutating action') }
    window.api = {
      getStatus: async () => data.status, refreshStatus: async () => data.status,
      getTools: async () => data.tools, checkTools: async () => data.tools, getSettings: async () => data.settings,
      getUpdate: async () => data.update, onUpdate: off, onStatus: off, onCheckProgress: off, onTools: off, onInstallLog: off,
      setClientEnabled: readOnly, toolAction: readOnly, proxyAction: readOnly, compressorAction: readOnly,
      saveSettings: readOnly, updateAction: readOnly, updatePreferences: readOnly,
      proxyLogs: async () => '', compressorLogs: async () => '',
      requestDetail: async (id) => ({ id, logged: true, found: true, original: [], compressed: [], response: 'Demo response' })
    }
  }, fixture)
  await page.goto('http://docs.example/')
  await page.getByRole('heading', { name: /^AI Desktop Proxy/, level: 1 }).waitFor()
  const output = join(root, 'docs/images')
  await mkdir(output, { recursive: true })
  for (const name of ['Overview', 'Savings', 'Tools', 'Settings']) {
    await page.getByRole('tab', { name, exact: true }).click()
    if (name === 'Tools') await page.locator('.tool-title').filter({ hasText: 'RTK' }).waitFor()
    if (name === 'Settings') await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor()
    await page.evaluate(() => document.fonts.ready)
    assert.deepEqual(errors, [], `${name}: renderer errors`)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name}: horizontal overflow`)
    const capture = { path: join(output, `${name.toLowerCase()}.png`), animations: 'disabled' }
    if (name === 'Settings') await page.screenshot(capture)
    else await page.locator('main').screenshot(capture)
    if (name === 'Settings') {
      await page.screenshot({ path: join(output, 'settings-full.png'), fullPage: true, animations: 'disabled' })
    }
    console.log(`Captured ${name}`)
  }
} finally { await browser.close() }
