import { expect, test } from '@playwright/test'
import { DEMO, DEMO_OFF, trackErrors } from './support'

// The chrome around the views: the demo banner, the skip link, tabs, titles, focus after actions that remove
// the focused control, live announcements and thumb-sized targets.

test('the demo says so, full width, on every page', async ({ page }) => {
  for (const hash of ['#/', '#/kids', '#/kid/8783', '#/about', '#/nope']) {
    await page.goto(`${DEMO}${hash}`)
    const banner = page.getByRole('complementary', { name: 'Demo mode' })
    await expect(banner).toHaveText('DEMO: not real chain data')
    const box = await banner.boundingBox()
    expect(box?.x).toBe(0)
    expect(box?.width).toBe(page.viewportSize()?.width)
  }
})

test('the skip link jumps to the view without routing anywhere', async ({ page }) => {
  const errors = trackErrors(page)
  await page.goto(`${DEMO}#/kids`)
  await expect(page.getByRole('link', { name: '#8073', exact: true })).toBeVisible()
  await page.keyboard.press('Tab')
  const skip = page.getByRole('link', { name: 'Skip to content' })
  await expect(skip).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#\/kids$/)
  await expect(page.getByRole('heading', { level: 2, name: 'My Eth kids' })).toBeFocused()
  await expect(page.getByText('Nothing here')).toHaveCount(0)
  expect(errors).toEqual([])
})

for (const width of [375, 330]) {
  test(`tabs stay on one line at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await page.goto(`${DEMO}#/`)
    const tabs = page.getByRole('navigation', { name: 'Sections' }).getByRole('link')
    await expect(tabs).toHaveCount(5)
    await expect(tabs.nth(1)).toContainText('2') // with the badge, the widest it gets
    await page.evaluate(() => document.fonts.ready)
    const boxes = await tabs.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON() as DOMRect))
    for (const b of boxes) {
      expect(b.top).toBe(boxes[0]?.top)
      expect(b.left).toBeGreaterThanOrEqual(0)
      expect(b.right).toBeLessThanOrEqual(width)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
  })
}

test('each view names the page', async ({ page }) => {
  await page.goto(`${DEMO}#/`)
  await expect(page).toHaveTitle('Bridge a kid · Bad Bridge')
  for (const [hash, title] of [
    ['#/kids', 'My Eth kids · Bad Bridge'],
    ['#/kid/8783', '#8783 · Bad Bridge'],
    ['#/kids/cosmos1qa3t6xrnec5cfhe6jhcyhfsptjm3ymwg6vlqk8', 'Eth kids for cosmos1qa3…lqk8 · Bad Bridge'],
    ['#/nope', 'Nothing here · Bad Bridge'],
  ] as const) {
    await page.evaluate((h) => (location.hash = h), hash)
    await expect(page).toHaveTitle(title)
  }
})

test('kid numbers outside the collection are nobody', async ({ page }) => {
  await page.goto(`${DEMO}#/kid/99999`)
  await expect(page.getByRole('heading', { level: 2, name: "There's no kid #99999" })).toBeVisible()
  await page.goto(`${DEMO}#/kids`)
  await page.getByLabel('Ethereum address, Hub address or kid number').fill('#99999')
  await page.getByRole('button', { name: 'Look up' }).click()
  await expect(page.getByRole('alert')).toHaveText("There's no kid #99999.")
  await expect(page).toHaveURL(/#\/kids$/)
})

test('connecting from the header lands focus on the new chip', async ({ page }) => {
  await page.goto(`${DEMO_OFF}#/kids`)
  await page.getByRole('button', { name: 'Connect Hub' }).click()
  await page.getByRole('dialog', { name: 'Connect Cosmos Hub' }).getByRole('button', { name: 'Connect Keplr' }).click()
  await expect(page.getByRole('button', { name: /^Cosmos Hub cosmos1q8m…3fxl$/ })).toBeFocused()
})

test('connecting Ethereum on the claim screen hands focus to the Claim button', async ({ page }) => {
  await page.goto(`${DEMO_OFF}#/kid/9254`)
  await page.getByRole('button', { name: 'Claim #9254' }).click()
  await page.getByRole('dialog', { name: 'Connect Ethereum' }).getByRole('button', { name: 'Connect MetaMask' }).click()
  await expect(page.getByRole('button', { name: 'Claim #9254' })).toBeFocused()
})

test('a tracker claim is announced while it runs, then focus lands on the kid', async ({ page }) => {
  // no `instant`: the demo wallet takes a moment to "sign"
  await page.goto('./?demo=paused#/crossing')
  const row = page.getByRole('list', { name: 'Kids on the bridge' }).getByRole('listitem').filter({ hasText: '#9254' })
  const claim = row.getByRole('button', { name: 'Claim' })
  await claim.click()
  await expect(page.getByRole('status').filter({ hasText: 'Approve it in MetaMask.' })).toBeVisible()
  await expect(row.getByRole('button', { name: 'Check MetaMask…' })).toBeFocused()
  await expect(row).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Crossing', exact: true })).toBeFocused()
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test('controls are thumb-sized', async ({ page }) => {
    const tall = async (loc: ReturnType<typeof page.locator>) => {
      for (const el of await loc.all()) expect((await el.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
    }
    await page.goto(`${DEMO}#/kids`)
    await expect(page.getByRole('link', { name: '#8073', exact: true })).toBeVisible()
    await tall(page.locator('.chip'))
    await tall(page.locator('.item summary'))
    await tall(page.getByRole('navigation', { name: 'Sections' }).getByRole('link'))

    await page.goto(`${DEMO_OFF}#/`)
    await expect(page.getByRole('heading', { level: 2, name: "Who's crossing?" })).toBeVisible()
    await tall(page.locator('.wallet-opt a.get'))
    await tall(page.locator('.chip'))
  })
})
