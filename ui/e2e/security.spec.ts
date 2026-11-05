import { expect, test } from '@playwright/test'
import { DEMO, DEMO_ETH, pickAndReview, sendButton } from './support'

// The send guards from the security review, on the demo adapter: what the review screen shows before the only
// irreversible action, the recipients it refuses, the shared-host switch-off, and the live trust facts on About.

const GOT_IT = 'Got it, one way only'

test('review shows the whole recipient and the msg the wallet will show', async ({ page }) => {
  await page.goto(`${DEMO}#/`)
  await pickAndReview(page, [9176, 6413])
  await expect(page.getByLabel('Ethereum address')).toHaveValue(DEMO_ETH)
  // 0x8f3a41b7e2D09C6A5E1f7b3C2d9A0e4f6b8Cc21d in fours
  await expect(page.getByText('0x8f3a 41b7 e2D0 9C6A 5E1f 7b3C 2d9A 0e4f 6b8C c21d')).toBeVisible()
  await expect(page.getByText('msg: jzpBt+LQnGpeH3s8LZoOT2uMwh0=')).toBeVisible()
  await expect(page.getByText(/for each kid\. It should match\./)).toBeVisible()
  await expect(page).toHaveTitle('Review and send · Bad Bridge')
})

test('"Got it" belongs to one address: a new address un-ticks it', async ({ page }) => {
  await page.goto(`${DEMO}#/`)
  await pickAndReview(page, [9176])
  await page.getByLabel(GOT_IT).check()
  await expect(sendButton(page)).toBeEnabled()
  await page.getByLabel('Ethereum address').fill('0x70997970C51812dc3A010C7d01b50e0d17dc79C8')
  await expect(page.getByLabel(GOT_IT)).not.toBeChecked()
  await expect(sendButton(page)).toBeDisabled()
  await expect(page.getByText('Tick “Got it, one way only” to send.')).toBeVisible()
})

test('burn and system addresses are refused', async ({ page }) => {
  await page.goto(`${DEMO}#/`)
  await pickAndReview(page, [9176])
  await page.getByLabel(GOT_IT).check()
  const input = page.getByLabel('Ethereum address')
  for (const address of ['0x000000000000000000000000000000000000dEaD', '0x0000000000000000000000000000000000000004']) {
    await input.fill(address)
    await expect(page.getByText("That's a burn or system address, not a wallet. Kids sent there are gone forever.")).toBeVisible()
    await expect(input).toHaveAttribute('aria-invalid', 'true')
    await expect(sendButton(page)).toBeDisabled()
  }
})

test('a wallet on another network does not fill in the recipient', async ({ page }) => {
  await page.goto('./?demo=paused,instant,wrongchain#/')
  await pickAndReview(page, [9176])
  await expect(page.getByText('Your wallet is on another network.')).toBeVisible()
  await expect(page.getByLabel('Ethereum address')).toHaveValue('')
  await page.getByLabel("It's a regular wallet: use the same address on Ethereum").click()
  await expect(page.getByLabel('Ethereum address')).toHaveValue(DEMO_ETH)
})

test('Send is off on a path-based IPFS gateway', async ({ page, baseURL }) => {
  // serve the build as if from ipfs.io/ipfs/<cid>/: same files, a shared-origin path
  const prefix = '/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
  await page.route(`**${prefix}/**`, (route) => route.continue({ url: route.request().url().replace(prefix, '') }))
  await page.goto(`${baseURL}${prefix}/?demo=paused,instant#/`)
  await pickAndReview(page, [9176])
  await page.getByLabel(GOT_IT).check()
  await expect(page.getByText(/Sending is off on this web address: it's shared with other sites/)).toBeVisible()
  await expect(sendButton(page)).toBeDisabled()
})

test('About builds its trust list from live reads, and never says "no admin keys"', async ({ page }) => {
  await page.goto(`${DEMO}#/about`)
  const trust = page.locator('ul.trust')
  // the demo's escrow has no admin; its collection has one (like the real Bad Kids cw721)
  await expect(trust.getByText('The escrow has no upgrade admin.')).toBeVisible()
  await expect(trust.getByText('Emergency unlock is renounced.')).toBeVisible()
  await expect(trust.getByText('The Bad Kids contract has an admin')).toBeVisible()
  await expect(trust.getByText(/governance can freeze that client or replace the router's entry/)).toBeVisible()
  await expect(trust.getByText(/the Eureka router that points to it can be upgraded/)).toBeVisible()
  await expect(page.getByText(/no admin keys/i)).toHaveCount(0)
  await expect(page.getByText(/nobody can pause/i)).toHaveCount(0)
  await expect(page.getByText(/Checked live: the escrow only takes Bad Kids, the Ethereum bridge only trusts this escrow/)).toBeVisible()
  await page.getByText('What does it cost?').click()
  await expect(page.getByText(/right now about 0\.00016 ETH for one kid, plus about 0\.00006 ETH for each extra kid/)).toBeVisible()
  await expect(page).toHaveTitle('About · Bad Bridge')
})
