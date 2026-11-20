import { expect, test, type Page, type TestInfo } from '@playwright/test'
import path from 'node:path'

// Read-only checks of the real app against the reece-test deployment on mainnet, in a browser with no wallet
// extension. Chain facts (checked 2026-09-27): #1 is still on the Hub; #2 and #3 were sent by REECE and minted to
// RECIPIENT. Kids can only move forward, so these stay true unless #1 crosses (then update KID_ON_HUB).

const REECE = 'cosmos1reece3m8g4m3d0qrpj93rnnseudnpzhrey64rr'
const RECIPIENT = '0xD2C392084761cb6E44c544B6f39dcc001fDe9775'
const BRIDGE = '0xDe185D7902340086cc4C37322584e246DC5eE198'
const ESCROW = 'cosmos1zr8k7ch8e9g7lqcgcd0peaklj43ymxvcusvqk7ver4zaqgdvragq8gumtv'
const CW721 = 'cosmos158d2rz0aw8cxx86j0tl8gfwleqyqefr9xdgth2jdfse2d9uumltsu83rfr'
const LIGHT_CLIENT = '0x4bB8A05D5b40dF7a3B97770E1943461B681B62E9'
const KID_ON_HUB = 1
const KIDS_HOME = [2, 3] as const

/** Everything the app may talk to: the deployment's RPCs and the two image sources. Nothing else, ever. */
const ALLOWED_HOSTS = new Set([
  'localhost',
  'cosmos-rest.publicnode.com',
  'cosmos-rpc.polkachu.com',
  'cosmos-rpc.publicnode.com',
  'cosmoshub.rpc.kjnodes.com',
  'ethereum-rpc.publicnode.com',
  'badkidsweb.storage.googleapis.com',
  'gateway.pinata.cloud',
])

/** Known-harmless console noise. */
const IGNORED = [/WalletConnect Core is already initialized/i]

/** Console errors, page errors and requests to hosts outside ALLOWED_HOSTS. Checked after each test. */
function watch(page: Page): { problems: string[] } {
  const problems: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' && !IGNORED.some((r) => r.test(m.text()))) problems.push(`console: ${m.text()}`)
  })
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`))
  page.on('request', (r) => {
    const host = new URL(r.url()).hostname
    if (!r.url().startsWith('data:') && !ALLOWED_HOSTS.has(host)) problems.push(`request to ${r.url()}`)
  })
  page.on('websocket', (ws) => {
    const host = new URL(ws.url()).hostname
    if (!ALLOWED_HOSTS.has(host)) problems.push(`websocket to ${ws.url()}`)
  })
  return { problems }
}

async function screenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready)
  // kid pictures come from a public bucket; give them a moment, but a slow one doesn't fail the test
  await page.waitForFunction(() => [...document.images].every((img) => img.complete), undefined, { timeout: 10_000 }).catch(() => undefined)
  await page.screenshot({ path: path.join(testInfo.project.outputDir, 'screens', `${name}.png`), fullPage: true, animations: 'disabled' })
}

let watched: { problems: string[] }
test.beforeEach(({ page }) => {
  watched = watch(page)
})
test.afterEach(() => {
  expect(watched.problems).toEqual([])
})

for (const id of KIDS_HOME) {
  test(`#${id} is home on Ethereum, owned by the recipient, with Etherscan and OpenSea links`, async ({ page }, testInfo) => {
    await page.goto(`./#/kid/${id}`)
    const main = page.getByRole('main')
    await expect(main.getByRole('heading', { level: 2, name: `#${id}` })).toBeVisible()
    await expect(main.getByText('home on Ethereum', { exact: true })).toBeVisible()
    await expect(main.getByText('Home on Ethereum.', { exact: true })).toBeVisible()

    const facts = main.locator('dl.facts')
    await expect(facts.locator('dt', { hasText: 'Headed to' }).locator('+ dd')).toContainText(RECIPIENT)
    // still with the recipient, so no separate "Owner now" line
    await expect(facts.locator('dt', { hasText: 'Owner now' })).toHaveCount(0)
    await expect(facts.locator('dt', { hasText: 'Sent by' }).locator('+ dd').getByRole('link')).toHaveAttribute(
      'href',
      `https://www.mintscan.io/cosmos/address/${REECE}`,
    )
    await expect(main.getByRole('link', { name: /^Etherscan/ })).toHaveAttribute('href', `https://etherscan.io/nft/${BRIDGE}/${id}`)
    await expect(main.getByRole('link', { name: /^OpenSea/ })).toHaveAttribute('href', `https://opensea.io/assets/ethereum/${BRIDGE}/${id}`)
    // all four steps done
    await expect(main.locator('ol.stages li.done')).toHaveCount(4)
    await screenshot(page, testInfo, `kid-${id}`)
  })
}

test(`#${KID_ON_HUB} is still on the Hub`, async ({ page }, testInfo) => {
  await page.goto(`./#/kid/${KID_ON_HUB}`)
  const main = page.getByRole('main')
  await expect(main.getByText('on the Hub', { exact: true })).toBeVisible()
  await expect(main.getByText("Still on the Cosmos Hub. It hasn't been sent across.")).toBeVisible()
  await expect(main.getByRole('link', { name: /^Etherscan/ })).toHaveCount(0)
  await expect(main.locator('dl.facts dt')).toHaveCount(0)
  await screenshot(page, testInfo, `kid-${KID_ON_HUB}`)
})

/** The tracker lists every kid in KIDS_HOME as home, each linking to its own page. */
async function expectKidsHome(page: Page): Promise<void> {
  const list = page.getByRole('list', { name: 'Kids on the bridge' })
  for (const id of KIDS_HOME) {
    const row = list.getByRole('listitem').filter({ has: page.getByRole('link', { name: `#${id}`, exact: true }) })
    await expect(row).toHaveCount(1)
    await expect(row.getByText('home on Ethereum', { exact: true })).toBeVisible()
    await expect(row.getByRole('link', { name: `View #${id} on Etherscan` })).toHaveAttribute('href', `https://etherscan.io/nft/${BRIDGE}/${id}`)
  }
  await expect(page.getByText(/^\d+ home$/)).toBeVisible()
}

test('the tracker finds the kids by their Ethereum recipient', async ({ page }, testInfo) => {
  await page.goto(`./#/kids/${RECIPIENT.toLowerCase()}`)
  await expect(page.getByRole('heading', { level: 2, name: 'Kids for 0xD2C3…9775' })).toBeVisible()
  await expectKidsHome(page)
  await expect(page.getByText('Found by Ethereum address, so it works from any device.', { exact: false })).toBeVisible()
  await screenshot(page, testInfo, 'kids-by-eth')
})

test('the tracker finds the same trips by the Hub sender', async ({ page }, testInfo) => {
  await page.goto(`./#/kids/${REECE}`)
  await expect(page.getByRole('heading', { level: 2, name: 'Kids for cosmos1ree…64rr' })).toBeVisible()
  await expect(page.getByText('Every kid this Hub address sent, wherever it is on the bridge.')).toBeVisible()
  await expectKidsHome(page)
  await screenshot(page, testInfo, 'kids-by-hub')
})

test('About shows the real contracts, a live health strip, the trust facts and a passing contracts check', async ({ page }, testInfo) => {
  await page.goto('./#/about')
  const main = page.getByRole('main')
  for (const address of [ESCROW, CW721, BRIDGE, LIGHT_CLIENT]) await expect(main.getByRole('link', { name: address })).toBeVisible()

  const health = main.getByLabel('Bridge health')
  await expect(health).toContainText('Running.')
  const text = (await health.innerText()).replace(/\s+/g, ' ')
  const lag = /Ethereum is (?:about \d+ (?:min|hours)|less than a minute) behind the Hub|a long way behind/.exec(text)
  expect(lag, text).not.toBeNull()
  const heights = /Hub block ([\d,]+) · Ethereum has seen ([\d,]+)/.exec(text)
  expect(heights, text).not.toBeNull()
  const hub = Number(heights?.[1]?.replace(/,/g, ''))
  const client = Number(heights?.[2]?.replace(/,/g, ''))
  // past the send heights of #2 and #3, and Ethereum behind (or level with) the Hub
  expect(client).toBeGreaterThan(33_092_463)
  expect(hub).toBeGreaterThanOrEqual(client)
  await expect(health).not.toContainText('Stuck')

  // trust facts, read live (2026-09-27): reece holds the admin of both the test escrow and ReeceBadTest, and the
  // Eureka router is an EIP-1967 proxy
  const trust = main.locator('ul.trust')
  await expect(trust.getByText('This test escrow has an admin')).toBeVisible()
  await expect(trust.getByText('The ReeceBadTest contract has an admin')).toBeVisible()
  await expect(trust.getByRole('link', { name: /cosmos1ree…64rr/ }).first()).toHaveAttribute('href', `https://www.mintscan.io/cosmos/address/${REECE}`)
  await expect(trust.getByText(/the Eureka router that points to it can be upgraded/)).toBeVisible()
  await expect(page.getByText(/no admin keys/i)).toHaveCount(0)

  // the startup sanity check (escrow config, bridge.ESCROW(), ROUTER(), clientId() and the client's chain) passes
  await expect(
    main.getByText(
      '✓ Checked live: the escrow only takes ReeceBadTest, the Ethereum bridge only trusts this escrow, and it follows the Cosmos Hub through the light client above.',
    ),
  ).toBeVisible()
  await expect(page.getByText('Sending is switched off')).toHaveCount(0)
  await expect(page.getByText('The bridge is stuck for now')).toHaveCount(0)
  await page.getByText('What does it cost?').click()
  await expect(main.getByText(/right now about [\d.]+ ETH for one kid/)).toBeVisible()
  await screenshot(page, testInfo, 'about')
})

test('the real build ignores ?demo', async ({ page }) => {
  await page.goto('./?demo=paused,instant#/about')
  const main = page.getByRole('main')
  await expect(main.getByText('These are the test deployment (ReeceBadTest).', { exact: false })).toBeVisible()
  await expect(main.getByText('This is the demo', { exact: false })).toHaveCount(0)
  await expect(page.getByText('not real chain data')).toHaveCount(0)
  await expect(main.getByLabel('Bridge health')).toContainText('Hub block')
})

test('the pick screen without a Hub wallet offers the wallets, none installed', async ({ page }, testInfo) => {
  await page.goto('./#/')
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { level: 2, name: "Who's crossing?" })).toBeVisible()
  await expect(main.getByText('Connect your Cosmos Hub wallet to see your kids.')).toBeVisible()
  const wallets = main.getByRole('list', { name: 'Cosmos Hub wallets' })
  for (const name of ['Keplr', 'Leap', 'Cosmostation']) {
    const item = wallets.getByRole('listitem').filter({ hasText: name })
    await expect(item.getByText('not installed', { exact: true })).toBeVisible()
    await expect(item.getByRole('link', { name: new RegExp(`Get it.*${name}`) })).toBeVisible()
  }
  // no WalletConnect without VITE_WC_PROJECT_ID, and nothing offers to connect
  await expect(wallets.getByRole('listitem')).toHaveCount(3)
  await expect(wallets.getByRole('button')).toHaveCount(0)
  // so phone users are sent to their wallet app's browser first
  await expect(main.getByText("Open this page in the Keplr or Leap app's browser.", { exact: false })).toBeVisible()
  await expect(main.getByRole('link', { name: 'Open in Keplr' })).toHaveAttribute('href', /^https:\/\/deeplink\.keplr\.app\/web-browser\?url=http/)
  await screenshot(page, testInfo, 'pick')
})

test('the header connect sheets list the right wallets', async ({ page }, testInfo) => {
  await page.goto('./#/kids')
  // disabled until the wallet code has loaded, with the same label
  await page.getByRole('button', { name: 'Connect Hub' }).click()
  const hubSheet = page.getByRole('dialog', { name: 'Connect Cosmos Hub' })
  await expect(hubSheet.getByRole('listitem')).toHaveCount(3)
  await expect(hubSheet.getByText('not installed', { exact: true })).toHaveCount(3)
  await screenshot(page, testInfo, 'connect-hub')
  await page.keyboard.press('Escape')
  await expect(hubSheet).toBeHidden()

  await page.getByRole('button', { name: 'Connect Ethereum' }).click()
  const ethSheet = page.getByRole('dialog', { name: 'Connect Ethereum' })
  // no extension in headless Chromium: no EIP-6963 wallets and no window.ethereum, so only Coinbase's web wallet
  const items = ethSheet.getByRole('listitem')
  await expect(items).toHaveCount(1)
  await expect(items.first()).toContainText('Coinbase Wallet')
  await expect(items.first().getByText('app or QR code', { exact: true })).toBeVisible()
  await expect(ethSheet.getByText("Open this page in your wallet app's browser", { exact: false })).toBeVisible()
  await expect(ethSheet.getByRole('button', { name: 'Connect Coinbase Wallet' })).toBeEnabled()
  await screenshot(page, testInfo, 'connect-eth')
})

test('a phone-width kid page fits the screen', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(`./#/kid/${KIDS_HOME[0]}`)
  await expect(page.getByRole('main').getByText('home on Ethereum', { exact: true })).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  await screenshot(page, testInfo, `kid-${KIDS_HOME[0]}-375`)
})
