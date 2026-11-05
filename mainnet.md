# Mainnet: real Bad Kids

Moving the bridge from the RBT2 test collection to the real Bad Kids. Everything here was pulled from chain on 2026-11-02, so re-check anything that looks stale.

## What we know

The real cw721 on the Hub:

|Thing|Value|
|-|-|
|cw721|`cosmos12gsv9tmjhhg86wg9fnd9cnju28jx3fxva9cn8dh9meketkfxxajqmg3exz`|
|code id|434 (`cw721_migration`, label `SG721-Bad Kids`)|
|wasm admin / migration supervisor|`cosmos1s8qx0zvz8yd6e4x0mqmqf7fr9vvfn6226hkvrq`|
|minter / owner|`cosmos1e09x7x0kvnfsyxj9nsfwdnp46f7q5k4qn8ezx0qd8w4sqxu8yjksw6mkly` (VendingMinter, code 419)|
|creator ownership|`cosmos15y38ehvexp6275ptmm4jj3qdds379nk02heclj`|
|minted|9995 (UI says 9999, close enough)|
|name / symbol|`Bad Kids` / `BADKIDS`|
|token URI|`ipfs://QmUoHk4hY6mNoHgNEJDcy94APUky6o8xVmyD3YzddJtUWe/<id>`|
|collection image|`ipfs://QmSFc8TPuVwLUfxEov7s66rfKoJ75NRcBRC4uQjMRcJoZ9/badkids.jpg`|
|royalty|5% to `cosmos1cr5zjgn2zz5sc7u9d0q76kjw9lx6mgrxr5hnh6` (single key, not a multisig)|

The token URI folder only has per-kid json, there's no collection file in it. Stargaze keeps collection info on chain, so `CONTRACT_URI` is a `data:` uri built from that (same trick as the test bridge).

Pinata is the only public gateway that still serves these. ipfs.io, dweb.link and w3s.link all 429 now.

## Deploy values

|Env|Value|
|-|-|
|`ESCROW`|raw 32 bytes of the new escrow, see step 2|
|`NAME` / `SYMBOL` / `BASE_URI` / `CONTRACT_URI`|defaults in `Deploy.s.sol` already match chain, don't set|

Default `CONTRACT_URI` is this json, base64'd into a `data:application/json;base64,` uri:

```json
{"name":"Bad Kids","description":"Bad Kids is a collection of 9,999 bad drawings of bad kids","image":"ipfs://QmSFc8TPuVwLUfxEov7s66rfKoJ75NRcBRC4uQjMRcJoZ9/badkids.jpg","external_link":"https://badkids.com/"}
```

The deploy log prints the base64 form. Check it with `echo <after base64,> | base64 -d`.

The bridge has no owner, so `contractURI` can't be changed after deploy. Double check it before you broadcast. No royalty either, on purpose.

## Before anything

- [ ] Repeat the unsigned `send_nft` simulation against the intended collection and escrow. The 2026-11-05 audit reached the receiver hook and got the expected wrong-collection rejection from the test escrow; this did not move a real kid
- [ ] Run the contract tests and real-proof fork test described in `README.md`, and rebuild the escrow artifact below
- [ ] Rotate `NETWORK_PRIVATE_KEY` (the old prover key leaked into a chat log)
- [ ] Audit `parse()` and the escrow receive path, fuzz more
- [ ] Set up Vercel with the artifact proxy, or "Prove it yourself" won't work. See `ui/README.md` Hosting
- [ ] Recheck the source collection's migration admin and resolve that trust assumption with its owners. The bridge cannot remove the source collection administrator's power to change its code
- [ ] Record the final escrow and bridge addresses. None of these launch actions is completed by running the local test suite

The tests exercise this bridge and its integration with the deployed verifier. They are not an independent audit of SP1's circuits, Eureka, or Cosmos Hub consensus.

## Steps

### 1. Escrow on the Hub

From the repository root, rebuild the current source with the pinned compiler and verify its checksum:

```bash
scripts/build-escrow.sh
(cd escrow/artifacts && shasum -a 256 -c checksums.txt)
```

Set all three deployment choices explicitly. The script has no collection, administrator, or signer defaults, and honors these environment values:

```bash
export CW721=cosmos12gsv9tmjhhg86wg9fnd9cnju28jx3fxva9cn8dh9meketkfxxajqmg3exz
export ADMIN=<temporary-admin-cosmos-address>   # EmergencyUnlock admin only
export FROM_KEY=<local-gaiad-key-name>
```

The internal `ADMIN` can refund tokens until renounced. There's no CosmWasm admin (`--no-admin`), so the code can never be migrated. Renounce the internal admin after the operator smoke test and **before enabling public deposits**. The UI won't send while it exists, so the smoke test send goes through `gaiad`. Keep the public UI closed throughout deployment and smoke testing.

```bash
gaiad tx wasm store escrow/artifacts/bad_bridge_escrow.wasm \
  --from "$FROM_KEY" --chain-id cosmoshub-4 --gas auto --gas-adjustment 1.3 --gas-prices 0.005uatom \
  --node https://cosmos-rpc.polkachu.com:443 -y

scripts/instantiate-escrow.sh <code-id> bad-kids-escrow
```

Before instantiation, query the uploaded code's checksum and compare it to `escrow/artifacts/checksums.txt`. After instantiation, confirm the configured collection, that the internal admin is `ADMIN`, and that the CosmWasm admin is empty on chain.

### 2. Escrow address as bytes32

```bash
export ESCROW=0x$(gaiad debug addr <escrow cosmos1...> | awk '/Address \(hex\)/{print tolower($3)}')
```

### 3. Bridge on Ethereum

```bash
cd eth
forge script script/Deploy.s.sol --rpc-url https://ethereum-rpc.publicnode.com --broadcast --account <deployer>
```

The script logs the bridge, light client and contractURI. Eyeball them before moving on, contractURI is final.

### 4. UI

Fill in the `badkids` entry in `ui/src/config/deployments.ts`, it's `hub(cw721, null)` and `eth(null)` right now:

- escrow address into `hub(...)`
- bridge address into `eth(...)` and `explorers(...)`

Build the public site with `VITE_DEPLOYMENT=badkids`, then update the Deployments section in `README.md`. Keep it closed until the smoke test and admin checks below pass.

## Smoke test

1. While the public UI remains closed, have the operator send one kid to the escrow with their ETH address as the msg. The UI blocks sends while the escrow has an admin, so use `gaiad`:

```bash
gaiad tx wasm execute <cw721 cosmos1...> '{"send_nft":{"contract":"<escrow cosmos1...>","token_id":"<id>","msg":"'$(echo <0x... without 0x> | xxd -r -p | base64)'"}}' \
  --from <operator-key-name> --chain-id cosmoshub-4 --gas auto --gas-adjustment 1.3 --gas-prices 0.005uatom \
  --node https://cosmos-rpc.polkachu.com:443 -y
```

2. If the Eureka client is stale, send a little ATOM over Eureka to nudge it (~10 min)
3. Open the kid in a local UI build and hit "Prove it yourself"
4. `claim(id)` and check `ownerOf`, `tokenURI` and `contractURI`
5. If the kid didn't land, `EmergencyUnlock` it back, fix, and deploy a new escrow and bridge. Only move on once a real kid has crossed
6. Renounce the escrow admin. While it's alive an `EmergencyUnlock` can put the same kid on both chains, even one with no `Proven` event yet, since any old Eureka root still proves the record. Don't unlock the smoke test kid, just renounce

```bash
gaiad tx wasm execute <escrow cosmos1...> '{"renounce_admin":{}}' \
  --from <admin-key-name> --chain-id cosmoshub-4 --gas auto --gas-adjustment 1.3 --gas-prices 0.005uatom \
  --node https://cosmos-rpc.polkachu.com:443 -y
```

Verify that raw escrow storage key `admin` is absent (`61646d696e` in hex), and that the contract's CosmWasm migration admin is still empty. Simulating another `renounce_admin` from the former admin must fail with `unauthorized`; there is no need to pay for a second transaction. Only then enable public deposits.

The Ethereum bridge permanently pins its light client. A retired, expired or frozen client can stop unfinished transfers; deploying another client alone does not update this bridge. Check the client's health and router mapping before opening deposits. Do not use EmergencyUnlock after any stored Hub root could prove the record, even if no Ethereum `Proven` event exists yet.
