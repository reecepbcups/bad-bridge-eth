//! Bad Bridge batcher. Finds escrow records not yet proven on Ethereum, proves them against the
//! Eureka cosmoshub-0 client's latest height with the SP1 membership program, and submits one batch.
//! Holds no special privileges: every submission is checked on-chain, anyone can run one.

mod hub;
mod state;
#[cfg(test)]
mod tests;

use alloy::eips::{BlockId, BlockNumberOrTag};
use alloy::network::EthereumWallet;
use alloy::primitives::{keccak256, Address, Bytes, FixedBytes, B256};
use alloy::providers::{Provider, ProviderBuilder};
use alloy::signers::local::PrivateKeySigner;
use alloy::sol;
use alloy::sol_types::SolValue;
use anyhow::{bail, Context, Result};
use sp1_sdk::blocking::{NetworkProver, ProveRequest, Prover, ProverClient};
use sp1_sdk::{Elf, HashableKey, ProvingKey, SP1ProvingKey, SP1Stdin};
use std::path::PathBuf;
use std::time::Duration;

sol! {
    #[derive(Debug, serde::Serialize, serde::Deserialize)]
    struct ConsensusState { uint128 timestamp; bytes32 root; bytes32 nextValidatorsHash; }
    #[derive(Debug, serde::Serialize, serde::Deserialize)]
    struct SP1Proof { bytes32 vKey; bytes publicValues; bytes proof; }
    struct KVPair { bytes[] path; bytes value; }
    struct TrustThreshold { uint8 numerator; uint8 denominator; }
    struct Height { uint64 revisionNumber; uint64 revisionHeight; }

    #[sol(rpc)]
    interface IBadBridge {
        function lightClient() external view returns (address);
        function proven(uint32 tokenId) external view returns (address recipient);
        function ESCROW() external view returns (bytes32);
        function submitBatch(uint64 proofHeight, ConsensusState cs, SP1Proof sp1Proof) external;
    }

    #[sol(rpc)]
    interface IClient {
        function clientState() external view returns (string chainId, TrustThreshold trustLevel, Height latestHeight, uint32 trustingPeriod, uint32 unbondingPeriod, bool isFrozen, uint8 zkAlgorithm);
        function getConsensusStateHash(uint64 revisionHeight) external view returns (bytes32);
        function MEMBERSHIP_PROGRAM_VKEY() external view returns (bytes32);
    }
}

struct Config {
    hub_rpcs: Vec<String>,
    hub_rest: String,
    eth_rpc: String,
    bridge: Address,
    escrow: String,
    elf: String,
    eth_key: PrivateKeySigner,
    poll: Duration,
    max_batch: usize,
    once: bool,
    state_file: PathBuf,
    recover_request_id: Option<B256>,
}

impl Config {
    fn from_env() -> Result<Self> {
        let var = |k: &str| std::env::var(k).with_context(|| format!("{k} must be set"));
        let or = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_string());
        let cfg = Self {
            hub_rpcs: or("HUB_RPCS", "https://cosmos-rpc.polkachu.com,https://cosmoshub.rpc.kjnodes.com,https://rpc-cosmoshub.ecostake.com")
                .split(',')
                .map(|s| s.trim().trim_end_matches('/').to_string())
                .collect(),
            hub_rest: or("HUB_REST", "https://cosmos-rest.publicnode.com"),
            eth_rpc: or("ETH_RPC", "https://ethereum-rpc.publicnode.com"),
            bridge: var("BRIDGE")?.parse().context("BRIDGE")?,
            escrow: var("ESCROW")?,
            elf: var("MEMBERSHIP_ELF")?,
            eth_key: var("ETH_PRIVATE_KEY")?.parse().context("ETH_PRIVATE_KEY")?,
            poll: Duration::from_secs(or("POLL_SECS", "60").parse().context("POLL_SECS")?),
            max_batch: or("MAX_BATCH", "50").parse().context("MAX_BATCH")?,
            once: or("ONCE", "0") == "1",
            state_file: or("BATCHER_STATE", "batcher-state.json").into(),
            recover_request_id: std::env::var("RECOVER_REQUEST_ID").ok().map(|s| s.parse()).transpose().context("RECOVER_REQUEST_ID")?,
        };
        var("NETWORK_PRIVATE_KEY")?; // read by sp1-sdk, fail fast here instead of mid-proof
        if cfg.max_batch == 0 || cfg.max_batch > u16::MAX as usize {
            bail!("MAX_BATCH must be 1..=65535");
        }
        Ok(cfg)
    }
}

fn main() -> Result<()> {
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into())).init();
    let cfg = Config::from_env()?;
    let store = state::Store::open(cfg.state_file.clone())?;
    let escrow_raw = hub::escrow_raw(&cfg.escrow)?;
    let hub = hub::Hub::new(cfg.hub_rpcs.clone(), cfg.hub_rest.clone())?;

    // alloy is async, sp1's blocking client builds its own runtime, so keep them apart
    let rt = tokio::runtime::Runtime::new()?;
    let provider = ProviderBuilder::new().wallet(EthereumWallet::from(cfg.eth_key.clone())).connect_http(cfg.eth_rpc.parse()?);
    let bridge = IBadBridge::new(cfg.bridge, &provider);
    let chain_id = rt.block_on(provider.get_chain_id())?;
    if rt.block_on(async { bridge.ESCROW().call().await })? != B256::from(escrow_raw) {
        bail!("ESCROW does not match the Ethereum bridge");
    }

    let elf = std::fs::read(&cfg.elf).with_context(|| format!("read {}", cfg.elf))?;
    let prover = ProverClient::builder().network().build();
    let pk = prover.setup(Elf::from(elf)).context("sp1 setup")?;
    let vkey: FixedBytes<32> = pk.verifying_key().bytes32().parse()?;

    let client_addr = rt.block_on(async { bridge.lightClient().call().await })?;
    let onchain_vkey = rt.block_on(async { IClient::new(client_addr, &provider).MEMBERSHIP_PROGRAM_VKEY().call().await })?;
    if vkey != onchain_vkey {
        bail!("elf vkey {vkey} != client MEMBERSHIP_PROGRAM_VKEY {onchain_vkey}, use the matching sp1-programs release");
    }
    if let Some(id) = cfg.recover_request_id {
        let mut pending = store.load()?.context("RECOVER_REQUEST_ID requires an existing saved batch")?;
        pending.check_identity(chain_id, cfg.bridge, &cfg.escrow, vkey)?;
        pending.recover_request_id(id)?;
        store.save(&pending)?;
        tracing::info!(request_id = %id, "request id saved; restart without RECOVER_REQUEST_ID to resume");
        return Ok(());
    }
    tracing::info!(bridge = %cfg.bridge, client = %client_addr, %vkey, escrow = %cfg.escrow, "batcher started");

    loop {
        let result = tick(&cfg, &hub, &escrow_raw, &rt, &provider, &prover, &pk, &store, chain_id);
        if cfg.once {
            return result;
        }
        if let Err(e) = result {
            tracing::error!(error = format!("{e:#}"), "tick failed");
        }
        std::thread::sleep(cfg.poll);
    }
}

fn tick<P: Provider>(
    cfg: &Config,
    hub: &hub::Hub,
    escrow_raw: &[u8; 32],
    rt: &tokio::runtime::Runtime,
    provider: &P,
    prover: &NetworkProver,
    pk: &SP1ProvingKey,
    store: &state::Store,
    chain_id: u64,
) -> Result<()> {
    let vkey = pk.verifying_key().bytes32().parse()?;
    if let Some(mut pending) = store.load()? {
        pending.check_identity(chain_id, cfg.bridge, &cfg.escrow, vkey)?;
        return finish_pending(&mut pending, store, rt, provider, |id| {
            let (proof, status) = prover.process_proof_status(id, None).context("poll saved proof request")?;
            tracing::info!(request_id = %id, ?status, "polled saved proof request");
            Ok(proof.map(|proof| SP1Proof { vKey: vkey, publicValues: Bytes::from(proof.public_values.to_vec()), proof: Bytes::from(proof.bytes()) }))
        });
    }
    let bridge = IBadBridge::new(cfg.bridge, provider);
    let client = IClient::new(rt.block_on(async { bridge.lightClient().call().await })?, provider);
    let cs = rt.block_on(async { client.clientState().call().await })?;
    if cs.isFrozen {
        bail!("client is frozen");
    }
    let height = cs.latestHeight.revisionHeight;

    let records = hub.records(&cfg.escrow)?;
    let ids: Vec<_> = records.iter().map(|r| r.token_id).collect();
    let recipients = rt.block_on(proven_recipients(provider, cfg.bridge, &ids, BlockId::latest()))?;
    let unproven: Vec<_> = records.into_iter().zip(recipients).filter_map(|(r, recipient)| (recipient == Address::ZERO).then_some(r)).collect();
    if unproven.is_empty() {
        tracing::info!(height, "nothing to prove");
        return Ok(());
    }

    // app hash at H commits to state after H-1, so query there
    let query_height = height.checked_sub(1).context("light client has no proof height")?;
    let batch = hub::eligible_batch(&unproven, escrow_raw, cfg.max_batch, |key| hub.prove(key, query_height))?;
    if batch.is_empty() {
        return Ok(());
    }

    let header = hub.header(height)?;
    let cs = ConsensusState {
        timestamp: header.timestamp_ns,
        root: header.app_hash.into(),
        nextValidatorsHash: header.next_validators_hash.into(),
    };
    let want = rt.block_on(async { client.getConsensusStateHash(height).call().await })?;
    if keccak256(cs.abi_encode()) != want {
        bail!("rebuilt consensus state at {height} doesn't match the client, wrong hub rpc?");
    }

    let ids: Vec<u32> = batch.iter().map(|r| r.token_id).collect();
    tracing::info!(height, count = batch.len(), ?ids, "proving batch");
    let mut stdin = SP1Stdin::new();
    stdin.write_slice(&header.app_hash);
    stdin.write_slice(&(batch.len() as u16).to_le_bytes());
    for r in &batch {
        let kv = KVPair { path: vec![Bytes::from_static(b"wasm"), Bytes::from(r.store_key.clone())], value: Bytes::from(r.value.clone()) };
        stdin.write_vec(kv.abi_encode());
        stdin.write_vec(r.merkle_proof.clone());
    }
    let pending = state::PendingBatch {
        chain_id,
        bridge: cfg.bridge,
        escrow: cfg.escrow.clone(),
        height,
        cs,
        token_ids: ids,
        vkey,
        request_id: None,
        proof: None,
        submitted: None,
    };
    store.request(pending, || prover.prove(pk, stdin).groth16().request().context("sp1 request"))?;
    Ok(())
}

/// Bound each eth_call and read every result afresh, so reorganizations cannot leave a stale cache.
async fn proven_recipients<P: Provider>(provider: &P, bridge: Address, ids: &[u32], block: BlockId) -> Result<Vec<Address>> {
    let contract = IBadBridge::new(bridge, provider);
    let mut recipients = Vec::with_capacity(ids.len());
    for chunk in ids.chunks(100) {
        let mut calls = provider.multicall().dynamic().block(block);
        for id in chunk {
            calls = calls.add_dynamic(contract.proven(*id));
        }
        let results = calls.aggregate().await?;
        if results.len() != chunk.len() {
            bail!("incomplete proven multicall response");
        }
        recipients.extend(results);
    }
    Ok(recipients)
}

fn finish_pending<P: Provider>(
    pending: &mut state::PendingBatch,
    store: &state::Store,
    rt: &tokio::runtime::Runtime,
    provider: &P,
    poll_proof: impl FnOnce(B256) -> Result<Option<SP1Proof>>,
) -> Result<()> {
    let complete = rt.block_on(async {
        let finalized = provider.get_block_by_number(BlockNumberOrTag::Finalized).await?.context("no finalized Ethereum block")?;
        let recipients = proven_recipients(provider, pending.bridge, &pending.token_ids, BlockId::hash_canonical(finalized.header.hash)).await?;
        anyhow::Ok(recipients.iter().all(|recipient| *recipient != Address::ZERO))
    })?;
    if complete {
        store.clear()?;
        tracing::info!(ids = ?pending.token_ids, "batch finalized; cleared saved job");
        return Ok(());
    }
    let current = rt.block_on(proven_recipients(provider, pending.bridge, &pending.token_ids, BlockId::latest()))?;
    if current.iter().all(|recipient| *recipient != Address::ZERO) {
        tracing::info!(ids = ?pending.token_ids, "batch proven; waiting for Ethereum finality");
        return Ok(());
    }
    if pending.proof.is_none() {
        let id = pending.request_id.context("proof request acceptance is unknown; preserve the state file and set RECOVER_REQUEST_ID to the existing request from the prover explorer")?;
        let Some(proof) = poll_proof(id)? else {
            return Ok(());
        };
        pending.proof = Some(proof);
        store.save(pending)?;
    }
    if let Some(sent) = &pending.submitted {
        if let Some(receipt) = rt.block_on(provider.get_transaction_receipt(sent.hash))? {
            if receipt.status() {
                // A mined transaction is not durable until its effects are finalized above.
                tracing::info!(tx = %sent.hash, "transaction mined; waiting for finality");
                return Ok(());
            }
            let hash = sent.hash;
            pending.submitted = None;
            store.save(pending)?;
            bail!("submitBatch reverted in {hash}; retaining proof for retry");
        }
        // A dropped transaction may be retried, but never purchase another proof for it.
        if state::now()?.saturating_sub(sent.sent_at) < 20 * 60 || rt.block_on(provider.get_transaction_by_hash(sent.hash))?.is_some() {
            tracing::info!(tx = %sent.hash, "waiting for submitted transaction");
            return Ok(());
        }
        pending.submitted = None;
        store.save(pending)?;
    }
    let bridge = IBadBridge::new(pending.bridge, provider);
    store.submit(pending, |batch| rt.block_on(async {
        let sent = bridge.submitBatch(batch.height, batch.cs.clone(), batch.proof.clone().context("missing saved proof")?).send().await?;
        anyhow::Ok(*sent.tx_hash())
    }))?;
    Ok(())
}
