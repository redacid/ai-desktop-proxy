#!/usr/bin/env node
// Generates the app and tray icons: SVG sources and every PNG the app ships.
//
//   node scripts/icons.mjs        (or: make icons)
//
// The mark: two chevrons squeezing a dot, ">•<" — traffic pinched through a local
// point (the proxy) and made smaller (the compressor). The animated variant pulses
// the squeeze; the tray plays it frame by frame while a service action runs.
//
// PNGs are rendered with Playwright's Chromium (not a project dependency: it is
// resolved from the global install, see docs/development.md). Output is committed,
// so building the app never needs a browser.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const res = join(root, 'resources')
const iconsDir = join(res, 'icons')
const trayDir = join(res, 'tray')
const srcDir = join(res, 'icon-src')

// Same colours as the window (src/renderer/src/styles.css).
const HEALTH = { ok: '#2f9e44', degraded: '#e8a10c', down: '#d6336c', unknown: '#9a9a94' }
const BUSY = '#4c8bf5'
const FRAMES = 8
const APP_SIZES = [16, 24, 32, 48, 64, 128, 256, 512]
const TRAY_SIZES = [16, 22, 24, 32]

/** Squeeze 0..1 for a phase 0..1: eases in, holds, eases out. */
const squeeze = (t) => (1 - Math.cos(2 * Math.PI * t)) / 2

// ── The mark, on a 24×24 grid ───────────────────────────────────────────────
// s = squeeze 0..1: the chevrons close in and the dot shrinks (gets compressed).
const CHEV_IN = 0.9
const DOT_R = 3.2
const DOT_R_SQUEEZED = 2.4
const leftChevron = (d) => `M${1.9 + d} 7 L${6.4 + d} 12 L${1.9 + d} 17`
const rightChevron = (d) => `M${22.1 - d} 7 L${17.6 - d} 12 L${22.1 - d} 17`
const SPLINE = 'calcMode="spline" keySplines=".45 0 .55 1;.45 0 .55 1"'
const DUR = '1.2s'
const pulse = (attr, a, b) =>
  `<animate attributeName="${attr}" values="${a};${b};${a}" dur="${DUR}" repeatCount="indefinite" ${SPLINE}/>`
const slide = (dx) =>
  `<animateTransform attributeName="transform" type="translate" values="0 0;${dx} 0;0 0" dur="${DUR}" repeatCount="indefinite" ${SPLINE}/>`

function mark(stroke, fill, s = 0, animated = false) {
  const d = CHEV_IN * s
  const r = DOT_R - (DOT_R - DOT_R_SQUEEZED) * s
  return `
  <g fill="none" stroke="${stroke}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="${leftChevron(d)}">${animated ? slide(CHEV_IN) : ''}</path>
    <path d="${rightChevron(d)}">${animated ? slide(-CHEV_IN) : ''}</path>
  </g>
  <circle cx="12" cy="12" r="${r.toFixed(2)}" fill="${fill}">${animated ? pulse('r', DOT_R, DOT_R_SQUEEZED) : ''}</circle>`
}

const traySvg = (color, s = 0, animated = false) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">${mark(color, color, s, animated)}\n</svg>\n`

// ── App icon, 512×512 ───────────────────────────────────────────────────────
const APP_DEFS = `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2c3250"/>
      <stop offset="1" stop-color="#10121b"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#51cf66" stop-opacity="0.45"/>
      <stop offset="1" stop-color="#51cf66" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="dot" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#b2f2bb"/>
      <stop offset="1" stop-color="#2f9e44"/>
    </linearGradient>
    <linearGradient id="chev" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#c5cbe0"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.10"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>`

function appSvg(s = 0, animated = false, small = false) {
  // The mark sits on a 348 px square in the middle of the tile (24 → 348: scale 14.5).
  const glowR = 120 - 20 * s
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">${APP_DEFS}
  <rect x="16" y="16" width="480" height="480" rx="112" fill="url(#bg)"/>
  ${small ? '' : `<rect x="16" y="16" width="480" height="480" rx="112" fill="url(#sheen)"/>
  <rect x="17" y="17" width="478" height="478" rx="111" fill="none" stroke="#ffffff" stroke-opacity="0.08" stroke-width="2"/>`}
  <circle cx="256" cy="256" r="${glowR}" fill="url(#glow)">${animated ? pulse('r', 120, 100) : ''}</circle>
  <g transform="translate(${small ? '64 64) scale(16)' : '82 82) scale(14.5)'}">${mark('url(#chev)', 'url(#dot)', s, animated)}
  </g>
</svg>
`
}

// ── Rendering ───────────────────────────────────────────────────────────────
function loadPlaywright() {
  const require = createRequire(import.meta.url)
  try {
    return require('playwright')
  } catch {
    const { execSync } = require('node:child_process')
    const globalRoot = execSync('npm root -g').toString().trim()
    return require(join(globalRoot, 'playwright'))
  }
}

async function main() {
  for (const dir of [iconsDir, trayDir, srcDir]) {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
  }

  // Sources
  writeFileSync(join(srcDir, 'icon.svg'), appSvg())
  writeFileSync(join(srcDir, 'icon-small.svg'), appSvg(0, false, true))
  writeFileSync(join(srcDir, 'icon-animated.svg'), appSvg(0, true))
  for (const [h, c] of Object.entries(HEALTH)) writeFileSync(join(srcDir, `tray-${h}.svg`), traySvg(c, 0))
  writeFileSync(join(srcDir, 'tray-busy-animated.svg'), traySvg(BUSY, 0, true))
  for (const [h, c] of Object.entries(HEALTH)) writeFileSync(join(srcDir, `tray-${h}-animated.svg`), traySvg(c, 0, true))

  const { chromium } = loadPlaywright()
  const browser = await chromium.launch()
  const page = await browser.newPage()
  const render = async (svg, size, out) => {
    await page.setViewportSize({ width: size, height: size })
    const sized = svg.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`)
    await page.setContent(
      `<html><body style="margin:0;background:transparent">${sized}</body></html>`
    )
    await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } })
  }

  // App icon: electron-builder takes the NxN.png folder for Linux.
  for (const size of APP_SIZES) {
    await render(appSvg(0, false, size < 48), size, join(iconsDir, `${size}x${size}.png`))
  }
  await render(appSvg(), 512, join(res, 'icon.png'))

  // Tray: <health>.png at 22 px plus @2x, which nativeImage picks up on HiDPI.
  for (const [h, c] of Object.entries(HEALTH)) {
    const svg = traySvg(c, 0)
    await render(svg, 22, join(trayDir, `${h}.png`))
    await render(svg, 44, join(trayDir, `${h}@2x.png`))
    for (const size of TRAY_SIZES) {
      await render(svg, size, join(trayDir, `${h}-${size}.png`))
      await render(svg, size * 2, join(trayDir, `${h}-${size}@2x.png`))
    }
  }
  // Busy animation frames.
  for (let i = 0; i < FRAMES; i++) {
    const svg = traySvg(BUSY, squeeze(i / FRAMES))
    await render(svg, 22, join(trayDir, `busy-${i}.png`))
    await render(svg, 44, join(trayDir, `busy-${i}@2x.png`))
  }
  await browser.close()
  console.log(`icons written to ${res}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
