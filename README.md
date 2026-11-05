# Bad Bridge

A one way bridge that moves Bad Kids from Cosmos Hub (cw721) to Ethereum (ERC721).

There's no relayer, no IBC channel and no light client of our own. The bridge reuses the SP1 light client of the Hub (`cosmoshub-0`) that IBC Eureka already runs on Ethereum mainnet. The full design is in [`bad-bridge-design.md`](bad-bridge-design.md).

## How it works

1. You `send_nft` your kid to the escrow on the Hub, with your Ethereum address as the message
2. The escrow stores a raw record, key `"b" || token_id` and value `<20 byte ETH address>`
3. A prover proves that record against the app hash the Eureka client stores, wrapped in an SP1 Groth16 proof. The UI's "Prove it yourself" does this from your own wallet
4. `BadBridge.submitBatch` checks the proof and records the token id and recipient
5. Anyone can call `claim(id)`, which mints that kid to the recipient

The prover can't lie since every record gets checked on chain. Worst case, nobody submits and kids wait.

Metadata doesn't move. `tokenURI` is `baseURI + id`, pointing at the same IPFS folder as the Hub collection.

## Repo layout

|Folder|What's in it|
|-|-|
|`escrow/`|CosmWasm escrow on the Hub|
|`eth/`|`BadBridge.sol`, the ERC721 on Ethereum|
|`ui/`|The web app (send, prove, claim). See [`ui/README.md`](ui/README.md)|
|`spec/`|Quint specs for both chains|
|`scripts/`|Escrow build and deploy helpers|

## Running the tests

```bash
cd escrow && cargo test   # tests/fuzz.rs runs random callers against a reference model
cd eth && forge test      # test/Access.t.sol covers who can call what. Invariants are slow (~10 min)
cd ui && pnpm check       # typecheck, lint, unit tests
```

The Ethereum side builds with Solar, so you need Foundry 1.9.0 or newer. Pull the pinned libraries first with `git submodule update --init --recursive`.

To run the real proof we checked in against the live Ethereum contracts (and make sure tampered proofs fail), point the fork test at an RPC. It forks mainnet locally and never broadcasts. Without `ETH_FORK_RPC` these tests skip.

```bash
cd eth
ETH_FORK_RPC=https://ethereum-rpc.publicnode.com forge test --match-contract RealProofForkTest
```

### Specs

Each Quint spec has a prod module that should hold and a broken variant that should fail, so you know the invariants actually bite.

|Spec|Covers|Should hold|Should break|
|-|-|-|-|
|`escrow.qnt`|escrow entry points|`escrowProd`|`escrowNoGuards`|
|`bridge.qnt`|`BadBridge.sol` entry points|`bridgeProd`|`bridgeNoGuards`, `bridgeUnpinned`|
|`badbridge.qnt`|both chains together|`prod`|`today`, `noCanonicalCheck`, `adminLive`, `escrowAdminLive`, `noSendGuard`|

```bash
cd spec
quint run escrow.qnt --main=escrowProd --invariant=safety --max-samples=100000 --max-steps=30
quint run bridge.qnt --main=bridgeProd --invariant=safety --max-samples=100000 --max-steps=30
quint run badbridge.qnt --main=prod --invariant=safety --max-samples=50000
quint verify escrow.qnt --main=escrowProd --invariant=safety --max-steps=6   # apalache, bounded
```

`adminLive` has two scripted exploits. Run them with `quint test badbridge.qnt --main=adminLive --match=AfterHonestUnlock`.

`noSendGuard` shows why the UI checks the light client before every send (`--match='sendIntoDeadClient|strandedInFlight'`). The second run is the gap nobody can close. A kid that's in flight when the client dies is stuck, even in prod.

## Deploying

Build the escrow with `scripts/build-escrow.sh` from the repo root. It rebuilds from source with the pinned optimizer and updates `escrow/artifacts/checksums.txt`. [`escrow/BUILD.md`](escrow/BUILD.md) has the details.

The full launch runbook for the real collection lives in [`mainnet.md`](mainnet.md). That covers the escrow, the bridge, the UI, the smoke test and removing the escrow admins before deposits open.

## Addresses

|Thing|Address|
|-|-|
|Bad Kids cw721 (Hub)|`cosmos12gsv9tmjhhg86wg9fnd9cnju28jx3fxva9cn8dh9meketkfxxajqmg3exz`|
|Eureka light client (Ethereum)|`0x4bB8A05D5b40dF7a3B97770E1943461B681B62E9`|
|Eureka router (Ethereum)|`0x3aF134307D5Ee90faa2ba9Cdba14ba66414CF1A7`|
|Escrow (Hub)|[`cosmos1x5t4r4ga8a6f6lr4zsgt5l6jw5mmq7nud3tg9hryvp532rdnn55qcer7zh`](https://www.mintscan.io/cosmos/wasm/contract/cosmos1x5t4r4ga8a6f6lr4zsgt5l6jw5mmq7nud3tg9hryvp532rdnn55qcer7zh)|
|BadBridge (Ethereum)|[`0x496f8D31eF5576A3f7057572829a74a90cF39E9a`](https://etherscan.io/address/0x496f8D31eF5576A3f7057572829a74a90cF39E9a)|

### Mainnet deploy (2026-11-05)

Escrow is code 822, wasm sha256 `6e32b99ee22cdbc3d2814c9dc2ca1dd7924a21e1f3ee9c25ff66c80b6a7183e2`. You can check it against `escrow/artifacts/checksums.txt`.

|Step|Tx|
|-|-|
|Store escrow code (height 33744147)|[`D8CD211D…F2DD3F9EA`](https://www.mintscan.io/cosmos/tx/D8CD211D482AD818D736A0C3C292B4C49C0B354A23C6145677A09F7F2DD3F9EA)|
|Instantiate escrow (height 33744160)|[`CAAE6822…AB8A15A9`](https://www.mintscan.io/cosmos/tx/CAAE6822053FFD622551085243E5808D87D59B56E2795E9B32EE4698AB8A15A9)|
|Deploy BadBridge (block 26351563)|[`0xe060b3ef…debc0609`](https://etherscan.io/tx/0xe060b3ef8e296afdf104a382ea0be6b83cb052d9e593d5ea121ba430debc0609)|

Escrow instantiate msg is just the collection:

```json
{"cw721":"cosmos12gsv9tmjhhg86wg9fnd9cnju28jx3fxva9cn8dh9meketkfxxajqmg3exz"}
```

The CosmWasm admin is `cosmos1reece3m8g4m3d0qrpj93rnnseudnpzhrey64rr` for now. It's only there for EmergencyUnlock during the smoke test and gets cleared before public deposits open.

BadBridge constructor args:

|Param|Value|
|-|-|
|router|`0x3aF134307D5Ee90faa2ba9Cdba14ba66414CF1A7`|
|client id|`cosmoshub-0`|
|escrow (bytes32)|`0x351751d51d3f749d7c751410ba7f527537b07a7c6c5682dc646069150db39d28`|
|name / symbol|`Bad Kids` / `BADKIDS`|
|base URI|`ipfs://QmUoHk4hY6mNoHgNEJDcy94APUky6o8xVmyD3YzddJtUWe/`|
|contractURI|`data:application/json;base64,...` of the json below|

```json
{"name":"Bad Kids","description":"Bad Kids is a collection of 9,999 bad drawings of bad kids. Escaped from the Cosmos.","image":"ipfs://QmSFc8TPuVwLUfxEov7s66rfKoJ75NRcBRC4uQjMRcJoZ9/badkids.jpg","external_link":"https://badkids.com/"}
```

## Things we learned the hard way

- A tokenfactory "ticket token" over Eureka ICS20 doesn't work. IBC v2 rejects denoms with a `/`
- The Ethereum router's `recvPacket` is permissioned, so we can't relay ourselves
- The Ethereum light client only moves when Eureka relays something. Send a little ATOM over Eureka to nudge it (~10 min)
- publicnode prunes too much state for proofs. Use polkachu, kjnodes or ecostake
- Use the `sp1-programs-v2.0.0` ELF. HEAD builds the wrong vkey
- `ConsensusState.timestamp` is in nanoseconds

## Trust

The bridge checks every kid against the Hub's state, but it still leans on SP1's circuits, IBC Eureka and Cosmos Hub consensus. Our tests cover this code and how it talks to the deployed verifier. They aren't an audit of those systems.

## License

[MIT](LICENSE)
