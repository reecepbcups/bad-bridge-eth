import { expect, test } from '@playwright/test'
import { BRIDGE, DEMO, DEMO_ETH, DEMO_OFF, OTHER_HUB, trackErrors } from './support'

// My kids: lookups, live rows, claim-all in one tx, share links, the single-kid page and About.

test('look up an address, then claim everything that is ready in one tx', async ({ page, context }) => {
  const errors = trackErrors(page)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto(`${DEMO_OFF}#/crossing`)
  await expect(page.getByText('Who are we looking for?')).toBeVisible()

  // lowercase works; the URL gets the checksummed form
  await page.getByLabel('Ethereum address, Hub address or kid number').fill(DEMO_ETH.toLowerCase())
  await page.getByRole('button', { name: 'Look up' }).click()
  await expect(page).toHaveURL(new RegExp(`#/crossing/${DEMO_ETH}$`))
  await expect(page.getByRole('heading', { level: 2, name: 'Crossing for 0x8f3a…c21d' })).toBeVisible()

  const list = page.getByRole('list', { name: 'Kids on the bridge' })
  const row = (id: number) => list.getByRole('listitem').filter({ hasText: `#${id}` }).first()
  await expect(row(9254).getByText('ready to claim', { exact: true })).toBeVisible()
  await expect(row(8783).getByText('crossing', { exact: true })).toBeVisible()
  await expect(row(8073)).toHaveCount(0)
  await expect(row(8783)).toContainText('Sent 22 min ago · Ethereum caught up, waiting for you to prove it')
  await expect(row(9254)).toContainText('Sent Sep 26, 9:12 pm')

  // what's happening, in detail
  await expect(page.locator('[aria-current="step"]')).toContainText('Prove it')

  // someone proves #8783: two ready, one tx claims both
  await page.evaluate(() => window.badBridgeDemo?.prove([8783]))
  await expect(page.getByText('2 ready', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Claim both' }).click()
  // no Ethereum wallet yet: the sheet asks for one first
  await page.getByRole('dialog', { name: 'Connect Ethereum' }).getByRole('button', { name: 'Connect MetaMask' }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'Crossing', exact: true })).toBeVisible()
  // the connect button became the real Claim button: focus follows it instead of dropping to <body>
  await expect(page.getByRole('button', { name: 'Claim both' })).toBeFocused()
  await page.getByRole('button', { name: 'Claim both' }).click()
  await expect(page.getByText('Nothing crossing for this address')).toBeVisible()
  await expect(page.getByRole('status').getByText('Claimed #8783 & #9254')).toBeVisible()
  await expect(page.getByRole('button', { name: /Claim/ })).toHaveCount(0)

  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'My Eth kids' }).click()
  for (const id of [8073, 8783, 9254]) await expect(row(id).getByText('home on Ethereum', { exact: true })).toBeVisible()
  await expect(row(8073).getByRole('link', { name: 'View #8073 on Blockscout' })).toHaveAttribute('href', `https://eth.blockscout.com/token/${BRIDGE}/instance/8073`)
  // share link
  await page.getByRole('button', { name: 'Copy share link' }).click()
  await expect(page.getByRole('button', { name: 'Copied!' })).toBeVisible()
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  expect(copied).toMatch(new RegExp(`\\?demo=paused,instant,disconnected#/kids/${DEMO_ETH}$`))
  expect(errors).toEqual([])
})

test('look up by Hub address and by kid number', async ({ page }) => {
  await page.goto(`${DEMO}#/kids`)
  const box = page.getByLabel('Ethereum address, Hub address or kid number')

  await box.fill('hello')
  await page.getByRole('button', { name: 'Look up' }).click()
  await expect(page.getByRole('alert')).toContainText('Paste an Ethereum address (0x…), a Hub address (cosmos1…) or a kid number')
  await expect(box).toHaveAttribute('aria-invalid', 'true')

  await box.fill(OTHER_HUB)
  await page.getByRole('button', { name: 'Look up' }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'Eth kids for cosmos1qa3…lqk8' })).toBeVisible()
  await expect(page.getByText('Every kid this Hub address sent', { exact: false })).toBeVisible()
  await expect(page.getByRole('link', { name: '#1234', exact: true })).toBeVisible()
  for (const id of [9254, 8783, 42]) await expect(page.getByRole('link', { name: `#${id}`, exact: true })).toHaveCount(0)

  await box.fill('#1234')
  await page.getByRole('button', { name: 'Look up' }).click()
  await expect(page).toHaveURL(/#\/kid\/1234$/)
  await expect(page.getByRole('heading', { level: 2, name: '#1234' })).toBeVisible()
  await expect(page.getByText('home on Ethereum', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: /^OpenSea/ })).toHaveAttribute('href', `https://opensea.io/assets/ethereum/${BRIDGE}/1234`)
})

test('a bad address in the URL says so instead of searching', async ({ page }) => {
  await page.goto(`${DEMO}#/kids/0x1234`)
  await expect(page.getByRole('alert')).toContainText("That doesn't look like an Ethereum address")
  await expect(page.getByRole('list', { name: 'Kids on the bridge' })).toHaveCount(0)
})

test('an address with nothing on the bridge gets an empty state', async ({ page }) => {
  await page.goto(`${DEMO}#/kids/0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359`)
  await expect(page.getByText('No kids home on Ethereum for this address')).toBeVisible()
})

test('network trouble shows a friendly error with a retry', async ({ page }) => {
  await page.goto(`${DEMO}#/kid/8783`)
  await expect(page.locator('.kid-head').getByText('crossing', { exact: true })).toBeVisible()
  await page.evaluate(() => window.badBridgeDemo?.setOffline(true))
  // same page, new route: this kid's reads all fail
  await page.getByRole('navigation', { name: 'Demo controls' }).getByRole('link', { name: 'about' }).click()
  await page.evaluate(() => (location.hash = '#/kid/9254'))
  await expect(page.getByText("Can't reach the chains")).toBeVisible()
  // still offline: Try again tries, fails the same way
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByText("Can't reach the chains")).toBeVisible()
  // back online: the next refresh recovers on its own
  await page.evaluate(() => window.badBridgeDemo?.setOffline(false))
  await expect(page.getByText('ready to claim', { exact: true })).toBeVisible()
  await expect(page.getByText("Can't reach the chains")).toHaveCount(0)
})

test('a single kid page works for anyone, with its facts and a claim button', async ({ page }) => {
  await page.goto(`${DEMO_OFF}#/kid/42`)
  await expect(page.getByRole('heading', { level: 2, name: '#42' })).toBeVisible()
  await expect(page.getByText('ready to claim', { exact: true })).toBeVisible()
  await expect(page.getByText('Headed to')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Every kid headed there' })).toHaveAttribute('href', /#\/kids\/0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed$/)
  await expect(page.getByRole('button', { name: 'Claim #42' })).toBeVisible()
  await expect(page.getByText('Anyone can claim; it always goes to 0x5aAe…eAed.')).toBeVisible()
})

test('About lists the contracts from the deployment, with live health', async ({ page }) => {
  await page.goto(`${DEMO}#/about`)
  const contracts = page.locator('dl.addrs')
  await expect(contracts.getByRole('link', { name: 'cosmos1rce3kmvc2v955f64gp8cjtwqzma3qg8t4puk7swmqd56j25gfqgq3s8037' })).toHaveAttribute(
    'href',
    'https://www.mintscan.io/cosmos/wasm/contract/cosmos1rce3kmvc2v955f64gp8cjtwqzma3qg8t4puk7swmqd56j25gfqgq3s8037',
  )
  await expect(contracts.getByRole('link', { name: BRIDGE })).toHaveAttribute('href', `https://eth.blockscout.com/address/${BRIDGE}`)
  await expect(contracts.getByRole('link', { name: '0x4bB8A05D5b40dF7a3B97770E1943461B681B62E9' })).toBeVisible()
  await expect(contracts.getByText('Bad Kids (Cosmos Hub)')).toBeVisible()
  await expect(contracts.getByRole('link', { name: 'github.com/reecepbcups/bad-bridge' })).toBeVisible()
  await expect(page.getByText('This is the demo: nothing here touches a real chain.', { exact: false })).toBeVisible()

  const health = page.getByLabel('Bridge health')
  await expect(health).toContainText('Running')
  await expect(health).toContainText('Ethereum is about 10 min behind the Hub')
  await page.getByText('Why does it take a while?').click()
  await expect(page.getByText("right now that's about 10 min.", { exact: false })).toBeVisible()
})
