import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

// Phase 0 smoke: every tab renders over the demo adapter at phone and desktop width, in both color
// schemes, with no horizontal scroll, no console errors and no serious axe violations.

const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 1280, height: 800 },
] as const
const SCHEMES = ['light', 'dark'] as const
const TABS = [
  { name: 'bridge', hash: '#/', tab: 'Bridge a kid', heading: "Who's crossing?", ready: '#663' },
  { name: 'crossing', hash: '#/crossing', tab: 'Crossing', heading: 'Crossing', ready: '#9254' },
  { name: 'kids', hash: '#/kids', tab: 'My Eth kids', heading: 'My Eth kids', ready: '#8073' },
  { name: 'about', hash: '#/about', tab: 'About', heading: "What's the Bad Bridge?", ready: 'Contracts' },
] as const

// paused: stable heights for screenshots; instant: no artificial latency
const DEMO = './?demo=paused,instant'

function trackErrors(page: Page): string[] {
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

for (const colorScheme of SCHEMES) {
  for (const viewport of VIEWPORTS) {
    test.describe(`${viewport.width}px ${colorScheme}`, () => {
      test.use({ viewport, colorScheme })

      for (const t of TABS) {
        test(`${t.name} tab`, async ({ page }, testInfo) => {
          const errors = trackErrors(page)
          await page.goto(`${DEMO}${t.hash}`)

          await expect(page.getByRole('heading', { level: 2, name: t.heading })).toBeVisible()
          await expect(page.getByText(t.ready, { exact: true }).first()).toBeVisible()
          await expect(page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: t.tab })).toHaveAttribute('aria-current', 'page')
          await page.evaluate(() => document.fonts.ready)

          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
          expect(overflow, 'horizontal scroll').toBeLessThanOrEqual(0)

          const { violations } = await new AxeBuilder({ page }).analyze()
          const serious = violations
            .filter((v) => v.impact === 'serious' || v.impact === 'critical')
            .map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)
          expect(serious).toEqual([])

          const shot = testInfo.outputPath(`${t.name}-${viewport.width}-${colorScheme}.png`)
          await page.screenshot({ path: shot, fullPage: true })
          await testInfo.attach('screenshot', { path: shot, contentType: 'image/png' })

          expect(errors).toEqual([])
        })
      }
    })
  }
}

test('tabs navigate and the badge counts kids on the way', async ({ page }) => {
  const errors = trackErrors(page)
  await page.goto(DEMO)
  const tabs = page.getByRole('navigation', { name: 'Sections' })
  await expect(tabs.getByRole('link', { name: /Crossing/ })).toContainText('2')
  await tabs.getByRole('link', { name: /Crossing/ }).click()
  await expect(page).toHaveURL(/#\/crossing$/)
  await expect(page.getByRole('heading', { level: 2, name: 'Crossing' })).toBeVisible()
  await tabs.getByRole('link', { name: 'About' }).click()
  await expect(page.getByRole('heading', { level: 2, name: "What's the Bad Bridge?" })).toBeVisible()
  expect(errors).toEqual([])
})

test('the demo adapter claims a ready kid', async ({ page }) => {
  await page.goto(`${DEMO}#/crossing`)
  const row = page.getByRole('listitem').filter({ hasText: '#9254' })
  await expect(row.getByText('ready to claim', { exact: true })).toBeVisible()
  await row.getByRole('button', { name: 'Claim' }).click()
  await expect(row).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: /Crossing/ })).toContainText('1')
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'My Eth kids' }).click()
  await expect(page.getByRole('listitem').filter({ hasText: '#9254' }).getByText('home on Ethereum', { exact: true })).toBeVisible()
})

test('dev toolbar skips a crossing kid ahead to ready', async ({ page }) => {
  await page.goto(`${DEMO}#/kid/8783`)
  await expect(page.locator('.kid-head').getByText('crossing', { exact: true })).toBeVisible()
  await page.getByRole('navigation', { name: 'Demo controls' }).getByRole('button', { name: 'skip ahead' }).click()
  await expect(page.getByText('ready to claim', { exact: true })).toBeVisible()
})
