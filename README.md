# Bad Bridge

One-way NFT bridge, Cosmos Hub cw721 -> Ethereum ERC721. Reuses the IBC Eureka `cosmoshub-0` SP1 light client already on Ethereum mainnet, so no relayer, no channel, no light client of our own. Design is in `bad-bridge-design.md`.

## How it works

1. `send_nft` to the Hub escrow, with your ETH address as the message
2. Escrow stores a raw record: key `"b" || token_id`, value `<20 byte ETH address>`
3. Batcher proves that record against the app hash the Eureka client stores, wraps it in a Groth16 proof with SP1
4. `BadBridge.submitBatch` verifies the proof and records token id + recipient
5. Anyone calls `claim(id)`, which mints that id to the recipient

The batcher can't lie, every record is checked on-chain. Worst case it just doesn't submit.

Metadata doesn't move. `tokenURI` is `baseURI + id`, same IPFS folder as the Hub.

## Pieces

|Piece|Where|
|-|-|
|escrow (CosmWasm)|`escrow/`|
|bridge (`BadBridge.sol`)|`eth/`|
|batcher (Rust)|`batcher/service/`|

## Checking it

Unit + fuzz tests:

```bash
cd escrow && cargo test        # tests/fuzz.rs runs random callers against a reference model
cd eth && forge test           # test/Access.t.sol is the who-can-call-what part, invariants are slow (~10 min)
```

Quint specs live in `spec/`. Each one has a prod module that should hold, plus a broken variant that should fail, so you know the invariants actually bite.

|Spec|What|Should hold|Should break|
|-|-|-|-|
|`escrow.qnt`|escrow entry points|`escrowProd`|`escrowNoGuards`|
|`bridge.qnt`|BadBridge.sol entry points|`bridgeProd`|`bridgeNoGuards`, `bridgeUnpinned`|
|`badbridge.qnt`|both chains together|`prod`|`today`, `noCanonicalCheck`, `adminLive`|

```bash
cd spec
quint run escrow.qnt --main=escrowProd --invariant=safety --max-samples=100000 --max-steps=30
quint run bridge.qnt --main=bridgeProd --invariant=safety --max-samples=100000 --max-steps=30
quint run badbridge.qnt --main=prod --invariant=safety --max-samples=50000
quint verify escrow.qnt --main=escrowProd --invariant=safety --max-steps=6   # apalache, bounded
```

`adminLive` in `badbridge.qnt` has two scripted exploits, run them with `quint test badbridge.qnt --main=adminLive --match=AfterHonestUnlock`.

## Deployments

Eureka light client: `0x4bB8A05D5b40dF7a3B97770E1943461B681B62E9`

**ReeceBadTest** (RBT, done, #2 and #3 bridged 2026-09-23)

- cw721: `cosmos158d2rz0aw8cxx86j0tl8gfwleqyqefr9xdgth2jdfse2d9uumltsu83rfr`
- escrow: `cosmos1zr8k7ch8e9g7lqcgcd0peaklj43ymxvcusvqk7ver4zaqgdvragq8gumtv`
- bridge: `0xDe185D7902340086cc4C37322584e246DC5eE198` (old version, no votes/owner/royalty)

**ReeceBadTestTwo** (RBT2, new bridge with votes, owner, royalty 5%)

- cw721: same as above
- escrow: `cosmos1rce3kmvc2v955f64gp8cjtwqzma3qg8t4puk7swmqd56j25gfqgq3s8037`
- bridge: `0xdDef181a0b9F5A090830F9ccBE5Ffb0D2BA07A7e`
- owner: `0xd0D72e3b30e3527490d5526456d58d1ea32905E0`

## Gotchas we hit

- Tokenfactory "ticket token" over Eureka ICS20 is dead, IBC v2 rejects denoms with a `/`
- Eth router `recvPacket` is permissioned, we can't relay ourselves
- Eth client only moves when Eureka relays something. Send a little ATOM over Eureka to nudge it (~10 min)
- publicnode prunes too much, use polkachu / kjnodes / ecostake for proofs
- Use the `sp1-programs-v2.0.0` ELF, HEAD builds the wrong vkey
- `ConsensusState.timestamp` is nanoseconds

## Before real Bad Kids

- Confirm `cw721-migration` (`cosmos12gsv9tmjhhg86wg9fnd9cnju28jx3fxva9cn8dh9meketkfxxajqmg3exz`) calls the receiver hook on `send_nft`
- Escrow with `--no-admin`
- Audit `parse()` and the escrow receive path, fuzz more
- Rotate the prover key, it leaked into a chat log
- Set up Vercel with the artifact proxy, or "Prove it yourself" won't work. See `ui/README.md` Hosting
