# Bad Bridge UI

The web app for Bad Bridge: send Bad Kids from your Cosmos Hub wallet, watch them cross, claim them on Ethereum. One way only. It's a static single-page app with no backend: the browser reads both chains straight from public RPCs and signs with your own wallets.

The plan and its decisions are in `PLAN.md`. The approved look is `mockup/index.html`. Lines waiting on copy sign-off are in `COPY.md`.

## Run it

Needs Node 24 and pnpm 10.

```bash
pnpm install
pnpm dev                # http://localhost:5173, real chains (reece-test unless VITE_DEPLOYMENT says otherwise)
pnpm build:reece-test   # dist/ for the test deployment; `pnpm build` alone needs VITE_DEPLOYMENT set
pnpm build:badkids      # dist/ for the real collection
pnpm preview            # serve dist/ on http://localhost:4173
```

`dist/` is static files with relative paths. Source maps are written next to the bundles but not linked from them; leave `dist/assets/*.map` out of the upload if they shouldn't be public.

In dev, add `?demo` to any URL for the demo: an in-memory sim of the mockup's example wallet, with a toolbar to skip ahead, freeze the bridge or inject failures. It touches no network. `?demo=paused,instant,disconnected` combine; see `src/chain/demo/options.ts`. A production build ignores `?demo` unless it was built with `VITE_ALLOW_DEMO=1` (the e2e build is), so nobody can send a link to the real site that shows fake chain data. Demo pages carry a full-width "DEMO" banner.

Settings (copy `.env.example` to `.env.local`):

| Variable | What |
|-|-|
| `VITE_DEPLOYMENT` | Which preset in `src/config/deployments.ts` to build: `reece-test`, `badkids-test`, `badkids` or `demo`. **Required** for a production build, which fails without it (a missing value used to ship reece-test silently). Dev falls back to `reece-test`. |
| `VITE_ALLOW_DEMO` | `1` makes a production build honour `?demo`. Only for test builds; leave it unset for a real site. |
| `VITE_WC_PROJECT_ID` | Reown (WalletConnect) project id. Without it only extension wallets and Coinbase Wallet are offered. The project's allowlist has to include the site's origin. |
| `VITE_ARTIFACT_PROXY_URL` | Where "Prove it yourself" sends Succinct artifact uploads/downloads. `/api` on Vercel (see Hosting). Dev defaults to the local `pnpm artifact-proxy`. A prod build without it can't prove. |

## Deployments

| Preset | Hub escrow | Hub cw721 | Ethereum bridge | State |
|-|-|-|-|-|
| `reece-test` | `cosmos1zr8k7ch8…q8gumtv` | ReeceBadTest `cosmos158d2rz0a…tsu83rfr` | `0xDe185D79…DC5eE198` | Live on mainnet. #2 and #3 crossed, #1 is still on the Hub. |
| `badkids` | not deployed | Bad Kids `cosmos12gsv9tmj…ajqmg3exz` | not deployed | Shows "the bridge isn't open yet". |
| `demo` | reece-test's addresses | | | In-memory, for review and e2e. |

Full addresses and RPC lists are in `src/config/deployments.ts`. At startup the app checks, against the chains:

- the escrow accepts the configured cw721;
- `bridge.ESCROW()` is the configured escrow;
- `bridge.ROUTER()` is IBC Eureka's router, pinned in the config (`0x3aF134307D5Ee90faa2ba9Cdba14ba66414CF1A7`, read from mainnet on 2026-09-27);
- `bridge.clientId()` is `cosmoshub-0`, the client the router hands back is the configured light client, and that client follows `cosmoshub-4`.

If any of these fails, Send is disabled and a banner says why. About also reads, live, who could change what a kid depends on: the escrow's and the collection's admins, and whether the Eureka router is an upgradeable proxy. These checks come from public RPCs, so they catch config and ops mistakes; they aren't a trust anchor.

Before each send the app also re-reads the light client (a frozen or unreadable client refuses the send), refuses fees and simulated gas far above what a send costs, caps a send at 50 kids, and refuses burn and precompile addresses as recipients.

## Tests

| Command | What | Needs |
|-|-|-|
| `pnpm check` | Typecheck, lint and unit tests (`src/**/*.test.ts(x)`, Vitest + jsdom) | Nothing |
| `pnpm test:e2e` | Playwright on the production build (reece-test, with `VITE_ALLOW_DEMO=1`) in demo mode: the whole flow, tracker, About, both themes, phone and desktop width, axe, and the send guards (`e2e/security.spec.ts`) | Chromium (`pnpm exec playwright install chromium`) |
| `pnpm test:live` | Read-only mainnet checks of the adapters against reece-test (`test/live/`) | Network |
| `pnpm test:fork` | Claims through the real writer on an Anvil mainnet fork, with proofs seeded by `anvil_setStorageAt` (`test/fork/`) | `anvil` on PATH (skips without it) and network |
| `pnpm test:e2e:live` | Playwright on the real reece-test build against mainnet with no wallet: kid pages, tracker by Eth and Hub address, About health, trust facts and contract check, `?demo` ignored, connect sheets, no console errors, no requests outside the RPC and image hosts (`e2e-live/`) | Chromium and network |

Only `check` and `test:e2e` are hermetic. The three live ones depend on public RPCs and on chain state that can only move forward; if #1 ever crosses, update the facts at the top of `e2e-live/live.spec.ts`. Screenshots land in `test-results/screens/` (demo) and `test-results-live/screens/` (live).

## Hosting

Host it only on an origin of its own: a dedicated domain or subdomain, or a subdomain IPFS gateway (`<cid>.ipfs.dweb.link`). On a path-based gateway (`ipfs.io/ipfs/<cid>/`, `gateway.pinata.cloud/ipfs/…`) or a GitHub project page (`user.github.io/repo/`), every other page on that origin can script this one and reuse the wallets' permissions for it. The app detects those hosts (`src/config/host.ts`) and switches Send off there, with a note saying why.

Headers to set, once each wallet has been tried against them with `Content-Security-Policy-Report-Only` first. No meta CSP ships yet: hosting is undecided, and it needs testing with every wallet.

```
Content-Security-Policy:
  default-src 'none';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  font-src 'self';
  img-src 'self' data: https://badkidsweb.storage.googleapis.com https://gateway.pinata.cloud
          https://api.web3modal.org https://explorer-api.walletconnect.com;          # last two only with VITE_WC_PROJECT_ID
  connect-src 'self'
          https://cosmos-rest.publicnode.com https://cosmos-rpc.polkachu.com
          https://cosmos-rpc.publicnode.com https://cosmoshub.rpc.kjnodes.com
          https://ethereum-rpc.publicnode.com
          https://rpc.wallet.coinbase.com https://keys.coinbase.com https://www.walletlink.org wss://www.walletlink.org
          wss://relay.walletconnect.org wss://relay.walletconnect.com https://rpc.walletconnect.org
          https://api.web3modal.org https://pulse.walletconnect.org
          https://verify.walletconnect.org https://verify.walletconnect.com;          # WC hosts only with a project id
  frame-src https://verify.walletconnect.org https://verify.walletconnect.com;       # 'none' without WC
  worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';
  frame-ancestors 'none'; upgrade-insecure-requests
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Cross-Origin-Opener-Policy: same-origin-allow-popups
Cross-Origin-Resource-Policy: same-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), hid=(), serial=(), bluetooth=(), browsing-topics=()
Cache-Control: no-cache (index.html); public, max-age=31536000, immutable (assets/*)
```

### Vercel + the artifact proxy

Succinct's S3 bucket has no CORS, so the browser can't upload the stdin/ELF or download the proof itself. `api/upload.ts` and `api/download.ts` are Vercel functions that do it server side (same thing as `scripts/artifact-proxy.mjs`, which is local only). They only forward to `spn-artifacts-mainnet.s3[.<region>].amazonaws.com`.

TODO before launch:

- [ ] Vercel project root dir = `ui`
- [ ] env `VITE_DEPLOYMENT=badkids` and `VITE_ARTIFACT_PROXY_URL=/api` (no trailing slash)
- [ ] preview deploy with `reece-test`, run "Prove it yourself" once end to end. The bucket hostname came from a comment, not a real proof URL, so this is the actual check

#### If proving breaks on the live site

- **"browsers can't upload to Succinct's artifact bucket"** - the request never reached anything. `VITE_ARTIFACT_PROXY_URL` wasn't set at build time. It's baked in by Vite, so set it and **redeploy**, changing the env alone does nothing
- **`artifact upload: HTTP 403` / `proof download: HTTP 403`** - open devtools Network, find the `/api/upload` or `/api/download` call
  - body says `refusing to proxy to <host>` - Succinct handed back a host the allowlist doesn't match. Fix the `ALLOWED_HOST` regex in both `api/*.ts`
  - body is S3 XML `AccessDenied` - it reached S3, the presigned url is bad or expired. Not the proxy
- **HTTP 404 on `/api/...`** - functions didn't deploy. Usually the root dir isn't `ui`, check the Functions tab in Vercel
- **HTTP 413** - body over Vercel's 4.5 MB limit. Shouldn't happen (ELF is ~470 KB) unless the program changed
- Function logs are in Vercel under the deployment -> Logs. Locally you can sanity check with `pnpm artifact-proxy` + `pnpm dev`

## How it's built

Every component reads chain state through one interface, `BridgeContext` (`src/chain/context.tsx`): a Hub reader, an Ethereum reader, a wallet per chain and a writer per chain, all defined in `src/chain/types.ts` with no library types in them. Either the demo sim fills it, or the real adapters, which come in two lazy chunks. The readers (fetch against Hub REST/RPC with fallback, viem with Multicall3) load first, so a kid's page renders without waiting for the wallet libraries; graz, cosmjs signing and wagmi load beside the page and slot in when ready. On top of that, `src/trips/` turns raw reads into a trip per kid, whose stage is always rebuilt from chain (localStorage only remembers which kids to show), and `src/ui/` draws it.

```
src/
  main.tsx  App.tsx  router.ts       hash routes: #/ #/kids #/kids/<0x…|cosmos1…> #/kid/<id> #/about
  config/deployments.ts              presets: addresses, RPCs, explorer links
  chain/
    types.ts  context.tsx            the adapter interface, and the React context around it
    real.tsx  wallets.tsx            real adapters: readers first, wallets lazily beside them
    hub/                             Cosmos Hub: REST/RPC transport, reader, send tx (simulate, sign, broadcast), graz + Leap
    eth/                             Ethereum: viem reader, claim/claim-many writer, wagmi config and wallets
    demo/                            in-memory sim behind the same interface (?demo)
    bech32.ts                        the one bech32 decoder the entry chunk needs
  trips/                             trip stages, discovery by address or id, health, react-query hooks
  ui/                                views and components, ported from the mockup
  kids/image.ts                      kid pictures: badkids.com bucket, IPFS fallback
  styles/                            tokens and base CSS from the mockup
e2e/  e2e-live/  test/live/  test/fork/
```

Bundle, gzipped: the entry is ~110 kB (React and react-query are most of it), a real page needs ~215 kB before it can draw, and the wallet chunk adds ~375 kB behind it. Most of that chunk is graz, which imports every cosmjs client and so all of `cosmjs-types`. Coinbase Wallet and WalletConnect load only when someone picks them, or on a reload when they were the last wallet used.
