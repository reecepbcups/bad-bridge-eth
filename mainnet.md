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
|`OWNER`|**TODO** SAFE or none?|
|`ROYALTY_BPS`|`500`|
|`ROYALTY_RECEIVER`|**TODO** Safe or someone else's 0x? defaults to `OWNER`|
|`CONTRACT_URI`|below|
|`NAME` / `SYMBOL` / `BASE_URI`|defaults in `Deploy.s.sol` already match chain, don't set|

```bash
export CONTRACT_URI='data:application/json;utf8,{"name":"Bad Kids","description":"Bad Kids is a collection of 9,999 bad drawings of bad kids","image":"ipfs://QmSFc8TPuVwLUfxEov7s66rfKoJ75NRcBRC4uQjMRcJoZ9/badkids.jpg","external_link":"https://badkids.co/"}'
```

Royalty isn't in the json on purpose, the contract does ERC2981. Owner can change both later.

## Before anything

- [ ] Make the Safe on Ethereum mainnet, 2 of 2, reece + jake
- [ ] Confirm `cw721_migration` actually calls the receiver hook on `send_nft`. If it doesn't, kids sent to escrow never get recorded. Dry run against the test escrow first
- [ ] Audit `parse()` and the escrow receive path, fuzz more
- [ ] Rotate `NETWORK_PRIVATE_KEY` (the old prover key leaked into a chat log)
- [ ] Fresh `ETH_PRIVATE_KEY` for the batcher with some ETH for gas

## Steps

### 1. Escrow on the Hub

`scripts/instantiate-escrow.sh` still points at the test cw721. Swap `CW721` to the real one first:

```bash
CW721=cosmos12gsv9tmjhhg86wg9fnd9cnju28jx3fxva9cn8dh9meketkfxxajqmg3exz
```

Admin (for EmergencyUnlock) stays `cosmos1reece3m8g4m3d0qrpj93rnnseudnpzhrey64rr` until it's renounced after the smoke test. It's `--no-admin` on the wasm side so nobody can migrate it.

```bash
gaiad tx wasm store escrow/artifacts/bad_bridge_escrow.wasm \
  --from income --chain-id cosmoshub-4 --gas auto --gas-adjustment 1.3 --gas-prices 0.005uatom \
  --node https://cosmos-rpc.polkachu.com:443 -y

scripts/instantiate-escrow.sh <code-id> bad-kids-escrow
```

### 2. Escrow address as bytes32

```bash
export ESCROW=0x$(gaiad debug addr <escrow cosmos1...> | awk '/Address \(hex\)/{print tolower($3)}')
```

### 3. Bridge on Ethereum

```bash
cd eth
export OWNER=<safe>
export ROYALTY_BPS=500
# export ROYALTY_RECEIVER=<0x...>   only if it's not the Safe
forge script script/Deploy.s.sol --rpc-url https://ethereum-rpc.publicnode.com --broadcast --account <deployer>
```

The script logs owner, royalty receiver, wei per 1 ETH and contractURI. Eyeball them before moving on.

### 4. Batcher

```bash
cd batcher/service
BRIDGE=<bridge 0x> \
ESCROW=<escrow cosmos1...> \
MEMBERSHIP_ELF=../elf/sp1-ics07-tendermint-membership \
ETH_PRIVATE_KEY=... \
NETWORK_PRIVATE_KEY=... \
cargo run --release
```

Use the `sp1-programs-v2.0.0` ELF, HEAD builds the wrong vkey.

### 5. UI

Fill in the `badkids` entry in `ui/src/config/deployments.ts`, it's `hub(cw721, null)` and `eth(null)` right now:

- escrow address into `hub(...)`
- bridge address into `eth(...)` and `explorers(...)`

Then update the Deployments section in `README.md`.

## Smoke test

1. Send one kid to the escrow with your ETH address as the msg
2. If the Eureka client is stale, send a little ATOM over Eureka to nudge it (~10 min)
3. Wait for the batcher to submit
4. `claim(id)` and check `ownerOf`, `tokenURI` and `royaltyInfo`
5. Renounce the escrow admin. While it's alive an `EmergencyUnlock` can put the same kid on both chains, even one with no `Proven` event yet, since any old Eureka root still proves the record. Don't unlock the smoke test kid, just renounce

```bash
gaiad tx wasm execute <escrow cosmos1...> '{"renounce_admin":{}}' \
  --from income --chain-id cosmoshub-4 --gas auto --gas-adjustment 1.3 --gas-prices 0.005uatom \
  --node https://cosmos-rpc.polkachu.com:443 -y
```

Run it again, it should fail with `unauthorized`. That means the admin is gone.

## Open

- Safe address?
- Royalty to the Safe or somewhere else?
