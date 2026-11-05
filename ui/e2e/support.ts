import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, type TestInfo } from '@playwright/test'
import path from 'node:path'

// Shared e2e helpers. Everything runs on the demo adapter (?demo): no network, deterministic.

/** paused: the virtual clock only moves when a test says so. instant: no fake wallet or read delays. */
export const DEMO = './?demo=paused,instant'
export const DEMO_OFF = './?demo=paused,instant,disconnected'

/** The demo's wallets and fixtures (src/chain/demo/seed.ts). */
export const DEMO_HUB = 'cosmos1q8m9275lcn5suv6c0k3v0mq3x639zqcq363fxl'
export const DEMO_ETH = '0x8f3a41b7e2D09C6A5E1f7b3C2d9A0e4f6b8Cc21d'
export const OTHER_HUB = 'cosmos1qa3t6xrnec5cfhe6jhcyhfsptjm3ymwg6vlqk8'
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'
export const BRIDGE = '0xdDef181a0b9F5A090830F9ccBE5Ffb0D2BA07A7e'

export const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 1280, height: 800 },
] as const
export const SCHEMES = ['light', 'dark'] as const

/** The slice of the demo sim tests poke through window.badBridgeDemo. */
interface DemoSimHandle {
  skip(): boolean
  advance(ms: number): void
  setFrozen(on: boolean): void
  prove(ids: readonly number[]): unknown
  setOffline(on: boolean): void
  setFailNext(code: string | null): void
  setWrongChain(on: boolean): void
  setWallet(chain: 'hub' | 'eth', connected: boolean): void
  commitSend(sender: string, ids: readonly number[], recipient: string): unknown
}

declare global {
  interface Window {
    badBridgeDemo?: DemoSimHandle
  }
}

/** Waits for the demo sim to be on window. Poke it with page.evaluate(() => window.badBridgeDemo?.…). */
export async function demoReady(page: Page): Promise<void> {
  await page.waitForFunction(() => window.badBridgeDemo !== undefined)
}

/** Collects console errors, page errors and any request that leaves localhost. */
export function trackErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('request', (r) => {
    if (!r.url().startsWith('http://localhost')) errors.push(`network request in demo mode: ${r.url()}`)
  })
  return errors
}

/** No horizontal scroll, no serious or critical axe violations, and a full-page screenshot to look at. */
export async function checkPage(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow, `${name}: horizontal scroll`).toBeLessThanOrEqual(0)

  const { violations } = await new AxeBuilder({ page }).analyze()
  const serious = violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)
  expect(serious, `${name}: axe`).toEqual([])

  const size = page.viewportSize()
  const scheme = await page.evaluate(() => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'))
  const file = path.join(testInfo.project.outputDir, 'screens', `${name}-${size?.width ?? 0}-${scheme}.png`)
  await page.screenshot({ path: file, fullPage: true, animations: 'disabled' })
}

/** Closes any toasts, so they don't sit on top of a screenshot. */
export async function dismissToasts(page: Page): Promise<void> {
  const x = page.locator('.toast .x').first()
  while (await x.count() > 0) await x.click()
}

/** The demo toolbar's "skip ahead": jumps to the next relay. */
export async function skipAhead(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: 'Demo controls' }).getByRole('button', { name: 'skip ahead' }).click()
}

/** Proves these kids straight in the sim, like someone else clicked "Prove it". */
export async function proveInSim(page: Page, ids: readonly number[]): Promise<void> {
  await page.evaluate((ids) => window.badBridgeDemo?.prove(ids), ids)
}

/** From a connected pick screen: pick these kids and go to review. */
export async function pickAndReview(page: Page, ids: readonly number[]): Promise<void> {
  for (const id of ids) await page.getByRole('button', { name: new RegExp(`^#${id} on the Hub`) }).click()
  await page.getByRole('button', { name: 'Next →' }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'Where do they land?' })).toBeVisible()
}

/** The review screen's Send button, whatever its label says right now. */
export function sendButton(page: Page) {
  return page.getByRole('main').getByRole('button', { name: /^(Send \d+ kids?|Checking…|Check .*…|Sending…)$/ })
}
