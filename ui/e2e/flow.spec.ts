import { expect, test } from '@playwright/test'
import {
  BRIDGE,
  DEMO,
  DEMO_ETH,
  DEMO_HUB,
  DEMO_OFF,
  demoReady,
  MULTICALL3,
  pickAndReview,
  proveInSim,
  sendButton,
  skipAhead,
  trackErrors,
} from './support'

// The bridge flow end to end on the demo adapter: pick → review → crossing → claim → done, and the ways
// Send refuses or fails.

test('send and claim announce writer progress and retain keyboard focus', async ({ page }) => {
  const errors = trackErrors(page)
  await page.goto('./?demo=paused#/')
  await demoReady(page)
  await pickAndReview(page, [9176])
  await page.getByLabel('Got it, one way only').check()
  await sendButton(page).click()
  await expect(sendButton(page)).toHaveText('Check Keplr…')
  await expect(sendButton(page)).toBeFocused()
  await expect(page.getByRole('status').filter({ hasText: 'Approve it in Keplr.' })).toBeVisible()
  await expect(page).toHaveURL(/#\/crossing$/)
  await expect(page).toHaveTitle('Crossing · Bad Bridge')
  await expect(page.getByRole('img', { name: /waiting for Ethereum to catch up/ })).toBeVisible()
  await skipAhead(page)
  await expect(page.getByRole('img', { name: /waiting for you to prove it/ })).toBeVisible()
  await proveInSim(page, [9176])
  const row = page.getByRole('listitem').filter({ hasText: '#9176' })
  await row.getByRole('button', { name: 'Claim', exact: true }).click()
  const claiming = row.getByRole('button', { name: 'Check MetaMask…' })
  await expect(claiming).toHaveAttribute('aria-disabled', 'true')
  await expect(claiming).toBeFocused()
  await expect(page.getByRole('status').filter({ hasText: 'Approve it in MetaMask.' })).toBeVisible()
  await expect(row).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Crossing', exact: true })).toBeFocused()
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'My Eth kids' }).click()
  await expect(page.getByRole('listitem').filter({ hasText: '#9176' }).getByText('home on Ethereum', { exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('happy path: connect both wallets, send two kids, cross, and batch claim', async ({ page }) => {
  const errors = trackErrors(page)
  await page.goto(`${DEMO_OFF}#/`)
  const wallets = page.getByRole('list', { name: 'Cosmos Hub wallets' })
  await expect(wallets.getByRole('link', { name: /Get it.*Cosmostation/ })).toBeVisible()
  await wallets.getByRole('button', { name: 'Connect Keplr' }).click()
  await expect(page.getByRole('heading', { name: "Who's crossing?" })).toBeFocused()
  await expect(page.getByRole('button', { name: /#8073/ })).toHaveCount(0)
  await pickAndReview(page, [9176, 6413])
  await expect(page.getByRole('heading', { name: 'Where do they land?' })).toBeFocused()
  await expect(sendButton(page)).toBeDisabled()
  await page.getByRole('button', { name: 'Connect Ethereum to fill it in' }).click()
  await page.getByRole('dialog', { name: 'Connect Ethereum' }).getByRole('button', { name: 'Connect MetaMask' }).click()
  await expect(page.getByLabel('Ethereum address')).toHaveValue(DEMO_ETH)
  await expect(page.getByLabel('Ethereum address')).toBeFocused()
  await page.getByLabel('Got it, one way only').check()
  await expect(page.getByText('≈ 0.00175 ATOM network fee.')).toBeVisible()
  await expect(page.getByText('Keplr asks you to sign once, for both kids.')).toBeVisible()
  await sendButton(page).click()
  await expect(page).toHaveURL(/#\/crossing$/)
  await expect(page.getByRole('heading', { name: 'Crossing', exact: true })).toBeFocused()
  for (const id of [9176, 6413]) await expect(page.getByRole('listitem').filter({ hasText: `#${id}` })).toBeVisible()
  await expect(page.getByRole('img', { name: /waiting for Ethereum to catch up/ })).toBeVisible()
  await skipAhead(page)
  await expect(page.getByRole('img', { name: /waiting for you to prove it/ })).toBeVisible()
  await proveInSim(page, [9176, 6413])
  // Includes the ready demo fixture; the other fixture is still waiting for a proof.
  await page.getByRole('button', { name: 'Claim all 3' }).click()
  await expect(page.getByRole('link', { name: '#9176', exact: true })).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: 'Claimed' })).toBeVisible()
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'My Eth kids' }).click()
  for (const id of [9176, 6413]) {
    const row = page.getByRole('listitem').filter({ hasText: `#${id}` })
    await expect(row.getByText('home on Ethereum', { exact: true })).toBeVisible()
    await expect(row.getByRole('link', { name: `View #${id} on Etherscan` })).toHaveAttribute('href', `https://etherscan.io/nft/${BRIDGE}/${id}`)
  }
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Bridge a kid' }).click()
  for (const id of [9176, 6413]) await expect(page.getByRole('button', { name: new RegExp(`^#${id} on the Hub`) })).toHaveCount(0)
  expect(errors).toEqual([])
})

test('a kid claimed from another view leaves Crossing and appears in My Eth kids', async ({ page }) => {
  await page.goto(`${DEMO}#/`)
  await pickAndReview(page, [663])
  await page.getByLabel('Got it, one way only').check()
  await sendButton(page).click()
  await expect(page).toHaveURL(/#\/crossing$/)
  await skipAhead(page)
  await proveInSim(page, [663])
  await page.getByRole('link', { name: '#663', exact: true }).click()
  await page.getByRole('button', { name: 'Claim #663' }).click()
  await expect(page.locator('.kid-head').getByText('home on Ethereum', { exact: true })).toBeVisible()
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: /Crossing/ }).click()
  await expect(page.getByRole('link', { name: '#663', exact: true })).toHaveCount(0)
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'My Eth kids' }).click()
  await expect(page.getByRole('link', { name: '#663', exact: true })).toBeVisible()
})

test.describe('Send refuses or fails', () => {
  test('UserRejected: a calm note, nothing sent, Send works again', async ({ page }) => {
    await page.goto(`${DEMO}#/`)
    await demoReady(page)
    await pickAndReview(page, [9176])
    await page.getByLabel('Got it, one way only').check()
    await expect(sendButton(page)).toHaveText('Send 1 kid')
    await page.evaluate(() => window.badBridgeDemo?.setFailNext('UserRejected'))
    await sendButton(page).click()
    const note = page.getByRole('alert').filter({ hasText: 'No worries' })
    await expect(note).toContainText('You said no in Keplr, so nothing happened.')
    await expect(page.getByRole('heading', { level: 2, name: 'Where do they land?' })).toBeVisible()
    await expect(sendButton(page)).toBeEnabled()
    await sendButton(page).click()
    await expect(page.getByRole('heading', { level: 2, name: 'Crossing', exact: true })).toBeVisible()
  })

  test('AlreadyBridged: the simulation says no, the wallet never opens, and the kid can be taken out', async ({ page }) => {
    await page.goto(`${DEMO}#/`)
    await demoReady(page)
    await pickAndReview(page, [9176, 6413])
    await page.getByLabel('Got it, one way only').check()
    await expect(sendButton(page)).toBeEnabled()
    // #9176 leaves from another tab
    await page.evaluate(
      ([hub, eth]) => window.badBridgeDemo?.commitSend(hub, [9176], eth),
      [DEMO_HUB, DEMO_ETH] as const,
    )
    await expect(page.getByRole('alert').filter({ hasText: '#9176 already crossed' })).toBeVisible()
    await expect(sendButton(page)).toBeDisabled()
    await expect(page.getByText('The Hub said no to this send (see above).')).toBeVisible()
    await page.getByRole('button', { name: 'Take #9176 out' }).click()
    await expect(sendButton(page)).toHaveText('Send 1 kid')
    await expect(sendButton(page)).toBeEnabled()
  })

  test('a frozen light client shows the stuck banner and hard-disables Send', async ({ page }) => {
    await page.goto(`${DEMO}#/`)
    await pickAndReview(page, [9176])
    await page.getByLabel('Got it, one way only').check()
    await expect(sendButton(page)).toBeEnabled()

    const bar = page.getByRole('navigation', { name: 'Demo controls' })
    await bar.getByRole('button', { name: 'more' }).click()
    await bar.getByRole('button', { name: 'frozen' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'The bridge is stuck for now' })).toBeVisible()
    await expect(sendButton(page)).toBeDisabled()
    await expect(page.getByRole('status').filter({ hasText: 'The bridge is stuck for now' })).toBeVisible()

    await bar.getByRole('button', { name: 'frozen' }).click()
    await expect(page.getByText('The bridge is stuck for now')).toHaveCount(0)
    await expect(sendButton(page)).toBeEnabled()
  })

  test('a contract recipient needs the second checkbox', async ({ page }) => {
    await page.goto(`${DEMO}#/`)
    await pickAndReview(page, [9176])
    await page.getByLabel('Got it, one way only').check()
    await page.getByLabel('Ethereum address').fill(MULTICALL3)
    await expect(page.getByText("That's a contract, not a wallet.")).toBeVisible()
    await expect(page.getByText("This isn't your connected wallet")).toBeVisible()
    await expect(sendButton(page)).toBeDisabled()
    await expect(page.getByText('Tick “This address can hold NFTs” to send to a contract.')).toBeVisible()
    await page.getByLabel('This address can hold NFTs').check()
    // "Got it" was for the old address, so it un-ticked when the address changed
    await expect(page.getByLabel('Got it, one way only')).not.toBeChecked()
    await page.getByLabel('Got it, one way only').check()
    await expect(sendButton(page)).toBeEnabled()
    // changing the address un-ticks it
    await page.getByLabel('Ethereum address').fill(BRIDGE)
    await expect(page.getByLabel('This address can hold NFTs')).not.toBeChecked()
    await expect(sendButton(page)).toBeDisabled()
  })

  test('bad addresses are blocked on every keystroke', async ({ page }) => {
    await page.goto(`${DEMO}#/`)
    await pickAndReview(page, [9176])
    await page.getByLabel('Got it, one way only').check()
    const input = page.getByLabel('Ethereum address')

    // one character's case flipped: fails EIP-55
    await input.fill('0x8f3a41b7e2D09C6A5E1f7b3C2d9A0e4f6b8Cc21D')
    await expect(page.getByText("The capital letters don't match this address's checksum", { exact: false })).toBeVisible()
    await expect(input).toHaveAttribute('aria-invalid', 'true')
    await expect(sendButton(page)).toBeDisabled()
    await expect(page.getByText('Fix the Ethereum address first.')).toBeVisible()

    await input.fill(`0x${'0'.repeat(40)}`)
    await expect(page.getByText("That's the zero address. Kids sent there are gone forever.")).toBeVisible()
    await input.fill('0x8f3a')
    await expect(page.getByText("That doesn't look like an Ethereum address (0x + 40 characters).")).toBeVisible()
    await expect(sendButton(page)).toBeDisabled()

    // all-lowercase has no checksum to fail
    await input.fill(DEMO_ETH.toLowerCase())
    await expect(input).toHaveAttribute('aria-invalid', 'false')
    await expect(sendButton(page)).toBeEnabled()
  })
})

test('claim on the wrong network: switch, then claim', async ({ page }) => {
  await page.goto('./?demo=paused,instant,wrongchain#/crossing')
  const row = page.getByRole('listitem').filter({ hasText: '#9254' })
  await expect(page.getByText('MetaMask is on another network.')).toBeVisible()
  await expect(row.getByRole('button', { name: 'Claim' })).toBeDisabled()
  await page.getByRole('button', { name: 'Switch to Ethereum' }).click()
  await expect(row.getByRole('button', { name: 'Claim' })).toBeEnabled()
  await row.getByRole('button', { name: 'Claim' }).click()
  await expect(row).toHaveCount(0)
})

test('a claim that fails with WrongChain explains itself', async ({ page }) => {
  await page.goto(`${DEMO}#/crossing`)
  await demoReady(page)
  await page.evaluate(() => window.badBridgeDemo?.setFailNext('WrongChain'))
  await page.getByRole('listitem').filter({ hasText: '#9254' }).getByRole('button', { name: 'Claim' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Wrong network' })).toContainText('Switch it to Ethereum mainnet')
})

test('keyboard: tiles toggle with Space, focus lands on each new heading', async ({ page }) => {
  await page.goto(`${DEMO}#/`)
  const tile = page.getByRole('button', { name: /^#663 on the Hub/ })
  await tile.focus()
  await page.keyboard.press('Space')
  await expect(tile).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Space')
  await expect(tile).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('Space')
  await page.getByRole('button', { name: 'Next →' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { level: 2, name: 'Where do they land?' })).toBeFocused()
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'About' }).click()
  await expect(page.getByRole('heading', { level: 2, name: "What's the Bad Bridge?" })).toBeFocused()
})

test('big wallets: 60 tiles, then "show more"', async ({ page }) => {
  await page.goto('./?demo=paused,instant,many#/')
  const tiles = page.getByRole('group', { name: 'Your kids' }).locator('.kid')
  await expect(tiles).toHaveCount(60)
  await expect(page.getByText('95 more in this wallet')).toBeVisible()
  await page.getByRole('button', { name: 'Show 60 more' }).click()
  await expect(tiles).toHaveCount(120)
  await page.getByRole('button', { name: 'Show 35 more' }).click()
  await expect(tiles).toHaveCount(155)
  // pictures load lazily; kids without one get a doodle
  await expect(page.locator('.kids img').first()).toHaveAttribute('loading', 'lazy')
  await expect(page.getByRole('img', { name: 'Bad Kid #1000' })).toHaveCount(0) // decorative inside a labelled tile
  await expect(page.getByRole('button', { name: /^#1000 on the Hub/ }).locator('svg.doodle')).toBeVisible()
})

test.describe('big wallets on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test('Next stays in reach while scrolling the grid', async ({ page }) => {
    await page.goto('./?demo=paused,instant,many#/')
    const next = page.getByRole('button', { name: 'Next →' })
    await page.getByRole('button', { name: /^#1003 on the Hub/ }).click()
    for (const y of [0, 1500, 4000]) {
      await page.evaluate((top) => window.scrollTo({ top }), y)
      await expect(next).toBeInViewport({ ratio: 1 })
    }
    await expect(page.getByText('1 kid picked')).toBeInViewport()
  })

  test('find a kid by number, and pick at most 50', async ({ page }) => {
    await page.goto('./?demo=paused,instant,many#/')
    const find = page.getByLabel('Find a kid by number')
    const grid = page.getByRole('group', { name: 'Your kids' })
    await find.fill('#104')
    await expect(grid.locator('.kid')).toHaveCount(11) // #1040–#1049 and #1104
    await find.fill('77777')
    await expect(page.getByRole('status').filter({ hasText: 'No kid #77777 in this wallet.' })).toBeVisible()
    await find.fill('')

    await page.getByRole('button', { name: 'Show 60 more' }).click()
    const home = grid.getByRole('button', { name: / on the Hub/ })
    for (let i = 0; i < 50; i++) await home.nth(i).click()
    await expect(page.getByText('50 kids picked')).toBeVisible()
    await expect(page.getByText('· Up to 50 at a time')).toBeVisible()
    // the 51st is refused, and says why
    const extra = home.nth(50)
    await expect(extra).toHaveAttribute('aria-disabled', 'true')
    await extra.click({ force: true }) // aria-disabled: Playwright won't click it unforced
    await expect(extra).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByText('50 kids picked')).toBeVisible()
    // letting one go makes room again
    await home.nth(0).click()
    await expect(page.getByText('49 kids picked')).toBeVisible()
    await expect(page.getByText('Up to 50 at a time')).toHaveCount(0)
  })
})

test('not live yet: no escrow, no sending', async ({ page }) => {
  await page.goto('./?demo=paused,instant,notlive#/')
  await expect(page.getByRole('heading', { level: 2, name: "The bridge isn't open yet" })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Next →' })).toHaveCount(0)
  // no steps to show for a bridge that isn't there, and real kids instead of doodles
  await expect(page.getByRole('region', { name: 'Bridge steps' })).toHaveCount(0)
  await expect(page.locator('.celebrate img')).toHaveCount(3)
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'About' }).click()
  await expect(page.getByText('not live yet')).toHaveCount(2)
})

test('reduced motion: walkers stand still at their stage', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(`${DEMO}#/`)
  await pickAndReview(page, [663])
  await page.getByLabel('Got it, one way only').check()
  await sendButton(page).click()
  const walker = page.locator('.scene .walker').last()
  // no tween: already at the catching-up anchor on first paint
  await expect(walker).toHaveAttribute('transform', /^translate\(196\.0,/)
  const animation = await page.locator('.scene .bob').first().evaluate((el) => getComputedStyle(el).animationName)
  expect(animation).toBe('none')
})
