# Copy for sign-off

Every line marked `COPY:` in `src/`, grouped by how much it matters. Line numbers point at the marker; the text
is right above it. Anything with `${…}` is filled in at runtime (kid numbers, wallet names, the collection).

Reply with edits per line, or "ok" per group. Once a line is signed off, delete its `COPY:` marker.

**New in the Phase 3 fixes** is marked *(new)*; lines whose wording changed are marked *(changed)*.

## Trust (new in Phase 3)

The About page used to say "No admin keys … Nobody can pause it, upgrade it or pull kids out", and `index.html`
said "no admin keys". Neither was true of the live deployment: the reece-test escrow and ReeceBadTest both have an
admin (reece), the Bad Kids cw721 has an admin, and BadBridge depends on IBC Eureka's light client, which Eureka's
governance can freeze or replace (its router is an upgradeable proxy). The list is now built per deployment from
live reads (`useTrustFacts`). ✓ marks a fact that holds, ! a caveat, ? a fact that couldn't be read.

| Where | Current text | Why it needs you |
|-|-|-|
| `src/ui/views/AboutView.tsx:243` | ! **This test escrow has an admin** (or **The escrow has an admin** on the real deployment) (*cosmos1ree…64rr*, linked) who can upgrade it. An upgrade could change where kids that haven't crossed yet end up. | *(new)* Shown when the escrow's `contract_info.admin` is set. True of reece-test today. |
| `src/ui/views/AboutView.tsx:248` | ✓ **The escrow has no admin.** Nobody can upgrade it or pull kids out. | *(new)* Only when the admin is empty. |
| `src/ui/views/AboutView.tsx:291` | ✓ **The Ethereum bridge has no owner or admin.** Nobody can upgrade it, change its settings or metadata, mint a kid without a proof or change the pinned light client. | *(new)* From the contract source (no owner, no proxy). Replaces "no admin keys". |
| `src/ui/views/AboutView.tsx:262` | ! **It leans on IBC Eureka.** BadBridge checks proofs against Eureka's light client of the Hub, and Eureka's governance can freeze or replace that client (the Eureka router that points to it can be upgraded). If it's frozen, new kids can't cross until it's fixed; kids that already made it across can still be claimed. | *(new)* Replaces "Nobody can pause it", which the frozen banner contradicted. The bracket shows when the router's EIP-1967 slot is set (it is today). |
| `src/ui/views/AboutView.tsx:272` | ! **The ${collection} contract has an admin** (*address*, linked) who can upgrade it, and an upgrade could move kids out of the escrow. The bridge can't stop that. | *(new)* True of ReeceBadTest and of the real Bad Kids cw721. |
| `src/ui/views/AboutView.tsx:277` | ✓ **The ${collection} contract has no admin.** Nobody can upgrade it to move kids out of the escrow. | *(new)* Only when the admin is empty. |
| `src/ui/views/AboutView.tsx:288` | Admins and upgradeability are read live from the chains' public endpoints, as a check on this site's settings. | *(new)* Under the list. Says what the reads are without overselling them. Unreadable facts show *Couldn't check who can change ${what} just now.* |
| `src/ui/views/AboutView.tsx:107` | *What happens to the kid on the Hub?* It stays locked in the escrow, which has no way to hand it back. That's what makes the Ethereum kid the real one. Then, when there's a collection admin: *One catch: the ${collection} contract has an admin who could upgrade it and move kids out of the escrow (see above).* Or an escrow admin: *One catch: this escrow has an admin who could upgrade it (see above).* | *(changed)* Was "It stays locked in the escrow forever", which isn't guaranteed while either contract has an admin. |
| `src/ui/views/AboutView.tsx:310` | OK: *✓ Checked live: the escrow only takes ${collection}, the Ethereum bridge only trusts this escrow, and it follows the Cosmos Hub through the light client above.* Mismatch: *✗ These don't match what the chains say, so sending is switched off.* Failed: *Couldn't double-check these against the chains just now.* Loading: *Double-checking these against the chains…* | *(changed)* The check now also covers `bridge.ROUTER()` (pinned), `bridge.clientId()`, the client the router hands back and its chain id, so the line covers every row above it. |
| `index.html:7` | Meta description: *Move your Bad Kids from the Cosmos Hub to Ethereum. One way only.* | *(changed)* Was "One way, no admin keys." |

## Disclosure and safety

These make promises or warn about things that can't be undone. They need your final wording.

| Where | Current text | Why it needs you |
|-|-|-|
| `src/ui/views/bridge/ReviewStep.tsx:258` | **No take-backs.** This bridge only goes one way. Once a kid leaves the Hub, it lives on Ethereum for good. Ethereum kids trade on Ethereum, separately from Bad Kids on the Hub and Stargaze. Checkbox: *Got it, one way only* | The disclosure from design doc §9 step 5. It's the last thing people read before the only irreversible action, and it gates the Send button. The tick now belongs to one address: changing the recipient un-ticks it. |
| `src/ui/views/AboutView.tsx:135` | *Ethereum and Hub kids: are they the same?* Same number, same art, but they trade separately. An Ethereum kid trades on Ethereum marketplaces, not on Stargaze or other Hub marketplaces. | The trading disclosure, in the FAQ. Should agree with the one above. |
| `src/ui/views/bridge/ReviewStep.tsx:200` | Under the address, the whole address in groups of four (*0x8f3a 41b7 e2D0 …*), then: **Check your wallet:** it will show *msg: 0sOSCEdhy25ExUS2853MAB/el3U=* (for each kid). It should match. | *(new)* Wallets show the recipient only as base64 inside the send_nft message; this lets people compare it before signing. |
| `src/ui/views/bridge/ReviewStep.tsx:221` | **Your wallet is on another network.** Smart-contract wallets may not exist at the same address on Ethereum. Checkbox: *It's a regular wallet: use the same address on Ethereum* | *(new)* A wallet on another network no longer fills in the recipient by itself. |
| `src/ui/views/bridge/ReviewStep.tsx:239` | **That's a contract, not a wallet.** Some contracts can't hold NFTs, and a kid minted to one could be stuck for good. Only go on if you're sure this one can. Checkbox: *This address can hold NFTs* | Shown when the recipient has code. Accurate: `claim` uses `_mint`, not `_safeMint`, so nothing stops a mint to a contract that can't move it. |
| `src/ui/views/bridge/ReviewStep.tsx:19` | Format: *That doesn't look like an Ethereum address (0x + 40 characters).* Zero: *That's the zero address. Kids sent there are gone forever.* Checksum: *The capital letters don't match this address's checksum, so there may be a typo. Copy it again from your wallet.* Burn: *That's a burn or system address, not a wallet. Kids sent there are gone forever.* | *(changed)* Burn is new: precompiles and system addresses up to 0x…ffff, and 0x…dEaD. |
| `src/ui/views/bridge/ReviewStep.tsx:29` | *Sending is off on this web address: it's shared with other sites, and any of them could tamper with this page. Open the bridge from its own address instead.* | *(new)* Shown on path-based IPFS gateways and GitHub project pages, where Send is switched off. |
| `src/ui/views/bridge/ReviewStep.tsx:95` | Why Send is off, new lines: *Send up to 50 at a time. Take some out and send the rest after.* / *Can't reach the chains to check the bridge right now, so sending is off until they answer.* / *The bridge is stuck for now, so sending is off.* | *(new)* The 50-kid cap, a failed health refresh (old numbers can't vouch for the light client), and the frozen client in the banner's words. |
| `src/ui/chrome/Banners.tsx:21` | **The bridge is stuck for now** Ethereum has stopped accepting updates from the Hub, so new kids can't cross and sending is off. Kids that already made it across can still be claimed. | *(changed by the design pass)* Site-wide when the Eureka client is frozen. States what still works, so it has to stay true. |
| `src/ui/chrome/Banners.tsx:30` | **Sending is switched off** The bridge contracts don't match this site's settings, so nothing can be sent until that's fixed. Your kids are safe. | Shown when the startup check fails. The per-problem lines under it come from `describeConfigProblem` in `src/trips/sanity.ts`, which now also explains a bridge wired to another router, client id, light client or chain. |
| `src/ui/chrome/DemoBanner.tsx:8` | **DEMO:** not real chain data | *(new, design pass)* On every demo page. Production builds only show the demo with `VITE_ALLOW_DEMO=1`. |
| `src/ui/views/bridge/PickStep.tsx:50` | **The bridge isn't open yet** ${collection} can't cross until the Hub escrow and the Ethereum contract are deployed. Nothing to do yet: your kids are safe where they are. | What the real Bad Kids build shows until the addresses exist. |

## Errors

| Where | Current text | Why it needs you |
|-|-|-|
| `src/ui/errors.ts:52` | The whole table, one entry per error code: | First drafts for every failure people can hit. Headlines never show the code; the raw detail sits in a "Details" disclosure. |
| | WrongCollection: *The escrow doesn't take this collection* / It only accepts Bad Kids from the official collection. Nothing was sent. | |
| | BadTokenId: *${kid}'s number looks off* / The escrow couldn't read the token number, so nothing was sent. | |
| | BadRecipient: *That address won't work* / The escrow wants a plain 0x Ethereum address (0x + 40 characters). Check it and try again. | |
| | ZeroRecipient: *That's the zero address* / Kids sent there are gone forever, so the send was stopped before it started. Nothing was sent. | *(changed)* Was "so the escrow said no": the app stops it before the escrow sees it. |
| | AlreadyBridged: *${kid} already crossed* / It's already in the escrow, and a kid can only cross once. Take it out of your pick and try again. | |
| | NotOwner: *${kid} isn't in this wallet* / The Hub says this wallet doesn't own it anymore. It may have moved since the list loaded. Nothing was sent. | |
| | TooManyKids: *That's a lot of kids at once* / Send up to 50 at a time. Take some out and send the rest after. Nothing was sent. | *(new)* The Hub writer refuses more than 50 kids per tx. |
| | FeeTooHigh: *That fee looks wrong* / The Hub quoted far more than a send should cost, so we stopped before your wallet opened. Nothing was sent. Try again in a bit. | *(new)* A simulate or fee far above a real send's (a lying endpoint). |
| | ClientFrozen: *The bridge is stuck for now* / Ethereum has stopped accepting updates from the Hub, so sending is off. Nothing was sent. Kids that already made it across can still be claimed. | *(new)* The light client froze between the page's last check and Send. |
| | NotProven: *Not quite there yet* / The proof for ${kid} hasn't landed on Ethereum yet. Give it a few minutes and try again. | |
| | UserRejected: *No worries* / You said no in ${wallet}, so nothing happened. Try again whenever you're ready. (Connect: ${wallet} didn't connect. Try again whenever you're ready.) | |
| | InsufficientFunds: *Not enough ETH for gas* / Claiming is a normal Ethereum transaction. Top up a little ETH and try again. (Send: *Not enough ATOM for the fee* / Sending needs a tiny bit of ATOM for the Hub fee. Top up and try again.) | |
| | WrongChain: *Wrong network* / ${wallet} is on a different network. Switch it to Ethereum mainnet (or Cosmos Hub) and try again. | |
| | NotLive: *The bridge isn't open yet* / This collection's escrow and Ethereum contract aren't deployed yet. Check back soon. | |
| | Network: *Can't reach the chains* / The public endpoints aren't answering. Check your connection and try again in a moment. | For a send, the review screen adds *Before sending again, check My kids in case it went through*, now only when the send was signed. |
| | Unknown: *Something went wrong* / Try again in a moment. If it keeps happening, the details below help us fix it. | |
| `src/ui/lookup.ts:12` | Empty: *Paste an Ethereum address (0x…), a Hub address (cosmos1…) or a kid number like #1234.* Out of range: *There's no kid #${id}.* Checksum: *That address's capital letters don't match its checksum, so there may be a typo.* Zero: *That's the zero address. No kids go there.* Burn: *That's a burn address. No kids go there.* Format: *That doesn't look like an Ethereum address (0x + 40 characters).* Bad bech32: *That Hub address has a typo somewhere.* | The tracker's lookup box. |
| `src/ui/views/KidView.tsx:48` | **There's no kid #${id}** ${collection} run from #1 to #${size}. *Look up another* | *(new, design pass)* Ids past `collectionSize`. |
| `src/ui/Broken.tsx:32` | Didn't load: **The bridge didn't finish loading** Part of the page didn't download. Check your connection and reload. Anything else: **Something broke while starting up** Reload to try again. If it keeps happening, let us know. Both end: *Your kids are safe: nothing here can move them without your wallet.* | Shown when the chain code itself fails. |
| `src/ui/Root.tsx:55` | **Oops, this page tripped** Something broke while drawing it. Your kids are safe: nothing here can move them without your wallet. | One view crashed; the rest of the app still works. |

## Explanations

| Where | Current text | Why it needs you |
|-|-|-|
| `src/ui/views/AboutView.tsx:56` | Step 1, **You send your kids**: They go into an escrow on the Hub, along with the Ethereum address they should land at. One signature sends up to 50 at a time. | *(changed)* Was "as many as you like"; sends are capped at 50. |
| `src/ui/views/AboutView.tsx:68` | Step 3, **You claim them**: The same kids, with the same numbers, get minted to your Ethereum address. One transaction claims them all. | Unmarked step 2 reads **You prove they left**: From your wallet, a zero-knowledge proof shows Ethereum that the kids really are locked on the Hub. |
| `src/ui/views/AboutView.tsx:90` | *Why does it take a while?* Ethereum only learns about new Hub blocks when IBC Eureka relays a transfer. After that, you prove them, and one proof covers all your waiting kids. So the wait depends on how far behind Ethereum is: right now that's ${lag}. | Replaces the mockup's made-up "20–60 minutes" with the live lag. |
| `src/ui/views/AboutView.tsx:119` | *What does it cost?* One Hub transaction sends up to 50 kids, for a small ATOM fee. Then one Ethereum transaction claims them all: right now about ${0.00016 ETH} for one kid, plus about ${0.00006 ETH} for each extra kid in the same claim. Proving adds about 0.33 PROVE plus about 0.002 ETH to submit it, the same for 1 kid or 50. (Without a gas price: *about 79,000 gas for one kid, plus about 30,000 for each extra kid in the same claim.*) | *(changed)* In ETH at the live gas price. Was "roughly 79,000 gas per kid"; fork runs show ~30k per extra kid in a batch. No batcher runs, so the user pays for the proof. |
| `src/ui/views/AboutView.tsx:127` | *Who can claim my kid?* Anyone. A claim always mints the kid to the address it was sent to, so it's safe for a friend (or a bot) to claim for you. | True of the contract today; keep it in step with the claim research. |
| `src/ui/views/AboutView.tsx:343` | **Running.** Ethereum is ${about N min} behind the Hub (${N} blocks). Hub block ${h} · Ethereum has seen ${c}. Checked ${when}. Stale: *Ethereum is a long way behind the Hub right now.* Failed: *Couldn't check just now, so these numbers may be old.* Frozen: **Stuck**: Ethereum has stopped accepting updates from the Hub, so new kids can't cross for now. | *(changed)* Frozen was **Paused**: the light client is frozen, so no new proofs. Now matches the banner. |
| `src/ui/views/bridge/ClaimStep.tsx:98` | Under the claim button: *≈ ${0.00022 ETH} network fee.* | *(new)* Simulated for exactly these kids when they're all claimable, else typical gas, times the live gas price. |
| `src/ui/views/bridge/ClaimStep.tsx:115` | One Ethereum transaction claims ${it / both / them all}. Anyone can claim; it always goes to ${recipient}. | *(changed)* "both" for two kids. The lede says *Claim to mint ${your kid / #n / both kids / all N kids}*. |
| `src/ui/views/bridge/ReviewStep.tsx:33` | Button: *Checking…* → *Check ${wallet}…* → *Sending…*. Line under it: *Checking the send with the Hub…* → *Approve it in ${wallet}. Once signed, it lands on the Hub in a few seconds.* → *Signed. Waiting for the Hub to put it in a block…* Idle: *${wallet} asks you to sign once(, for both kids / for all N kids).* | *(changed)* "both" for two kids. The line is now announced to screen readers. |
| `src/ui/Claim.tsx:63` | Button: *Check ${wallet}…* → *Claiming…*. Status: *Approve it in ${wallet}.* → *Sent. Waiting for Ethereum to mine it…* Toast after any claim: **Claimed ${#a & #b / N kids}** Minted on Ethereum. Welcome home. *See it on Etherscan* | *(changed)* The claim screen and the tracker now use the same toast, kids in the order they were sent. |
| `src/ui/StageList.tsx:54` | Stage details: *Locked in the Hub escrow · ${tx}* / *Ethereum updates its view of the Hub every so often.* (+ *${N blocks} to go.*) / *Anyone can prove it from their wallet, showing Ethereum the kid left the Hub. Nobody has to trust the prover.* (step 3 title while current: *Prove it*) / *Anyone can claim it, and it always lands at the address it was sent to.* | *(new, design pass)* |
| `src/ui/stages.ts:17` | Steps: *Sent → Ethereum caught up → Proven → Claimed on Ethereum*. Stage lines: *Still on the Hub*, *Sent, in the Hub escrow*, *Waiting for Ethereum to catch up*, *On the bridge*, *Ethereum caught up, waiting for you to prove it*, *Proven, ready to claim*, *Home on Ethereum*. | *(new, design pass)* One vocabulary for the journey everywhere. |
| `src/ui/chrome/Stepper.tsx:6` | *Send* from the Hub · *Cross* catch up, prove · *Claim* on Ethereum | *(new, design pass)* |
| `src/ui/views/bridge/CrossingStep.tsx:58` | Right now Ethereum is ${about N min} behind the Hub (or *almost caught up*, or once proving: *Ethereum has caught up; now the proof is being made.*). Close this tab if you like. Your ${kids} will be waiting under *My kids*. | *(changed, design pass)* The second "close this tab" note became a *Copy a link to check later* button. |
| `src/ui/views/KidsView.tsx:164` | *Found by (your) Ethereum address, so it works from any device.* / *Found by (your) Hub address, …* / *Kids sent from this browser. Look up an address to see them from any device.* | It used to say "your Ethereum address" for anyone's address. |

## Other

| Where | Current text | Why it needs you |
|-|-|-|
| `src/ui/Connect.tsx:204` | Hub: *Pick the wallet that holds your Bad Kids on the Cosmos Hub.* Ethereum: *Pick the wallet you use on Ethereum.* | *(changed, design pass)* "You can also paste any address instead" moved to the review screen. |
| `src/ui/Connect.tsx:106` | **On your phone?** Open this page in the Keplr or Leap app's browser. (Ethereum: *Open this page in your wallet app's browser (MetaMask, Rainbow, Coinbase Wallet).*) | *(new, design pass)* When no extension is found. |
| `src/ui/Connect.tsx:49` | Wallet tags: *installed* / *app or QR code* (Coinbase Wallet, WalletConnect) / *not installed* | *(new, design pass)* |
| `src/ui/views/bridge/PickStep.tsx:135` | **No ${collection} in this wallet** ${wallet} doesn't hold any on the Cosmos Hub. Using another account? Switch it in your wallet and this list updates. | Empty pick screen. |
| `src/ui/views/bridge/PickStep.tsx:194` | *${N} kids picked · Up to 50 at a time* | *(new, design pass)* Shown at the send cap. |

## Unmarked, worth a glance

- `src/ui/chrome/Footer.tsx`: *One way only: Cosmos Hub → Ethereum. There's no bridge back.* / *Same token IDs, same art. Metadata stays on IPFS; only the kid moves.*
- Page titles: *Review and send*, *Ready to claim*, *Welcome to Ethereum*, *About* (each *· Bad Bridge*), plus the design pass's titles for the other views.
