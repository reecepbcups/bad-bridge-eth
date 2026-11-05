import { expect, test, type Page } from '@playwright/test'
import {
  checkPage,
  DEMO,
  DEMO_OFF,
  demoReady,
  dismissToasts,
  MULTICALL3,
  pickAndReview,
  proveInSim,
  SCHEMES,
  sendButton,
  skipAhead,
  trackErrors,
  VIEWPORTS,
} from './support'

// Every screen and state, at phone and desktop width, light and dark: no horizontal scroll, no serious
// axe violations, no console errors. Screenshots land in test-results/screens/ for design review.

/** Walks one path through the app, checking each stop. */
type Stop = [name: string, reach: (page: Page) => Promise<void>]

const BRIDGE_WALK: Stop[] = [
  [
    'pick-connect',
    async (page) => {
      await page.goto(`${DEMO_OFF}#/`)
      await expect(page.getByRole('list', { name: 'Cosmos Hub wallets' })).toBeVisible()
    },
  ],
  [
    'connect-sheet',
    async (page) => {
      await page.getByRole('button', { name: 'Connect Ethereum' }).click()
      await expect(page.getByRole('dialog', { name: 'Connect Ethereum' })).toBeVisible()
    },
  ],
  [
    'pick',
    async (page) => {
      await page.getByRole('dialog').getByRole('button', { name: 'Connect MetaMask' }).click()
      await page.getByRole('list', { name: 'Cosmos Hub wallets' }).getByRole('button', { name: 'Connect Keplr' }).click()
      await page.getByRole('button', { name: /^#9176 on the Hub/ }).click()
      await page.getByRole('button', { name: /^#6413 on the Hub/ }).click()
      await expect(page.getByText('2 kids picked')).toBeVisible()
    },
  ],
  [
    'review',
    async (page) => {
      await page.getByRole('button', { name: 'Next →' }).click()
      await page.getByLabel('Got it, one way only').check()
      await expect(sendButton(page)).toBeEnabled()
    },
  ],
  [
    'review-contract',
    async (page) => {
      await page.getByLabel('Ethereum address').fill(MULTICALL3)
      await expect(page.getByText("That's a contract, not a wallet.")).toBeVisible()
    },
  ],
  [
    'review-bad-address',
    async (page) => {
      await page.getByLabel('Ethereum address').fill('0x8f3a41b7e2D09C6A5E1f7b3C2d9A0e4f6b8Cc21D')
      await expect(page.getByLabel('Ethereum address')).toHaveAttribute('aria-invalid', 'true')
    },
  ],
  [
    'review-rejected',
    async (page) => {
      await page.getByLabel('Ethereum address').fill('0x8f3a41b7e2D09C6A5E1f7b3C2d9A0e4f6b8Cc21d')
      // a new recipient un-ticks "Got it", so it's agreed for this address
      await page.getByLabel('Got it, one way only').check()
      await expect(sendButton(page)).toBeEnabled()
      await page.evaluate(() => window.badBridgeDemo?.setFailNext('UserRejected'))
      await sendButton(page).click()
      await expect(page.getByText('No worries')).toBeVisible()
    },
  ],
  [
    'crossing',
    async (page) => {
      await sendButton(page).click()
      await expect(page.getByRole('heading', { level: 2, name: 'Crossing', exact: true })).toBeVisible()
      await dismissToasts(page)
    },
  ],
  [
    'crossing-proving',
    async (page) => {
      await skipAhead(page)
      await expect(page.getByRole('img', { name: /waiting for you to prove it/ })).toBeVisible()
      // let the walkers finish walking
      await page.waitForTimeout(2800)
    },
  ],
  [
    'claim',
    async (page) => {
      await proveInSim(page, [9176, 6413])
      await expect(page.getByRole('button', { name: 'Claim all 3' })).toBeVisible()
    },
  ],
  [
    'done',
    async (page) => {
      await page.getByRole('button', { name: 'Claim all 3' }).click()
      await expect(page.getByRole('link', { name: '#9176', exact: true })).toHaveCount(0)
      await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'My Eth kids' }).click()
      await expect(page.getByRole('listitem').filter({ hasText: '#9176' }).getByText('home on Ethereum', { exact: true })).toBeVisible()
      await dismissToasts(page)
    },
  ],
]

const OTHER_STOPS: Stop[] = [
  [
    'tracker',
    async (page) => {
      await page.goto(`${DEMO}#/crossing`)
      await expect(page.getByRole('link', { name: '#9254', exact: true })).toBeVisible()
      await expect(page.getByRole('img', { name: /waiting for you to prove it/ })).toBeVisible()
    },
  ],
  [
    'tracker-empty',
    async (page) => {
      await page.goto(`${DEMO_OFF}#/kids`)
      await expect(page.getByText('Who are we looking for?')).toBeVisible()
    },
  ],
  [
    'kid',
    async (page) => {
      await page.goto(`${DEMO}#/kid/8783`)
      await expect(page.locator('.kid-head').getByText('crossing', { exact: true })).toBeVisible()
    },
  ],
  [
    'about',
    async (page) => {
      await page.goto(`${DEMO}#/about`)
      await expect(page.getByLabel('Bridge health')).toContainText('Running')
    },
  ],
  [
    'paused-banner',
    async (page) => {
      await page.goto(`${DEMO}#/`)
      await demoReady(page)
      await page.evaluate(() => window.badBridgeDemo?.setFrozen(true))
      await pickAndReview(page, [663])
      await expect(sendButton(page)).toBeDisabled()
      await expect(page.getByRole('status').filter({ hasText: 'The bridge is stuck for now' })).toBeVisible()
    },
  ],
  [
    'not-live',
    async (page) => {
      await page.goto('./?demo=paused,instant,notlive#/')
      await expect(page.getByRole('heading', { level: 2, name: "The bridge isn't open yet" })).toBeVisible()
    },
  ],
  [
    'many-kids',
    async (page) => {
      await page.goto('./?demo=paused,instant,many#/')
      await expect(page.getByRole('button', { name: 'Show 60 more' })).toBeVisible()
    },
  ],
  [
    'wrong-chain',
    async (page) => {
      await page.goto('./?demo=paused,instant,wrongchain#/crossing')
      await expect(page.getByRole('button', { name: 'Switch to Ethereum' })).toBeVisible()
    },
  ],
]

for (const colorScheme of SCHEMES) {
  for (const viewport of VIEWPORTS) {
    test.describe(`screens ${viewport.width}px ${colorScheme}`, () => {
      test.use({ viewport, colorScheme })
      // long walks with an axe run per stop: ~15s normally, so leave room for a busy machine
      test.describe.configure({ timeout: 90_000 })

      test('bridge flow', async ({ page }, testInfo) => {
        const errors = trackErrors(page)
        for (const [name, reach] of BRIDGE_WALK) {
          await test.step(name, async () => {
            await reach(page)
            await checkPage(page, testInfo, name)
          })
        }
        expect(errors).toEqual([])
      })

      test('tracker, kid, about and edge states', async ({ page }, testInfo) => {
        const errors = trackErrors(page)
        for (const [name, reach] of OTHER_STOPS) {
          await test.step(name, async () => {
            await reach(page)
            await checkPage(page, testInfo, name)
          })
        }
        expect(errors).toEqual([])
      })
    })
  }
}
