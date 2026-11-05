use super::*;
use alloy::primitives::U256;
use alloy::transports::mock::Asserter;
use std::sync::atomic::{AtomicU64, Ordering};

struct TestStore(PathBuf);

impl TestStore {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        Self(std::env::temp_dir().join(format!("bad-bridge-batcher-test-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed))))
    }
    fn open(&self) -> state::Store {
        state::Store::open(self.0.join("state.json")).unwrap()
    }
}

impl Drop for TestStore {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn batch() -> state::PendingBatch {
    state::PendingBatch {
        chain_id: 1,
        bridge: Address::repeat_byte(1),
        escrow: "test-escrow".into(),
        height: 123,
        cs: ConsensusState { timestamp: 1, root: B256::repeat_byte(2), nextValidatorsHash: B256::repeat_byte(3) },
        token_ids: vec![7012],
        vkey: B256::repeat_byte(4),
        request_id: None,
        proof: None,
        submitted: None,
    }
}

fn saved_proof() -> SP1Proof {
    SP1Proof { vKey: B256::repeat_byte(4), publicValues: Bytes::from_static(&[1, 2]), proof: Bytes::from_static(&[3, 4]) }
}

fn push_recipients(asserter: &Asserter, recipients: &[Address]) {
    let encoded: Vec<Bytes> = recipients.iter().map(|recipient| recipient.abi_encode().into()).collect();
    asserter.push_success(&Bytes::from((U256::from(100), encoded).abi_encode_params()));
}

fn push_chain_state(asserter: &Asserter, finalized: Address, current: Option<Address>) {
    let mut block: alloy::rpc::types::Block = Default::default();
    block.header.hash = B256::repeat_byte(9);
    block.header.number = 100;
    asserter.push_success(&Some(block));
    push_recipients(asserter, &[finalized]);
    if let Some(current) = current {
        push_recipients(asserter, &[current]);
    }
}

#[test]
fn ambiguous_request_is_durable_and_cannot_buy_again() {
    let files = TestStore::new();
    let store = files.open();
    let mut purchases = 0;
    assert!(store.request(batch(), || {
        assert!(store.load().unwrap().is_some(), "intent must reach disk before paying");
        purchases += 1;
        bail!("request accepted, connection lost before response")
    }).is_err());
    drop(store);
    let restarted = files.open();
    assert!(restarted.load().unwrap().unwrap().request_id.is_none());
    assert!(restarted.request(batch(), || {
        purchases += 1;
        Ok(B256::repeat_byte(5))
    }).is_err());
    assert_eq!(purchases, 1);
}

#[test]
fn persisted_request_is_polled_after_restarts_and_not_replaced_on_failure() {
    let files = TestStore::new();
    let store = files.open();
    let id = B256::repeat_byte(5);
    store.request(batch(), || Ok(id)).unwrap();
    drop(store);
    let store = files.open();
    let rt = tokio::runtime::Runtime::new().unwrap();
    let asserter = Asserter::new();
    let provider = ProviderBuilder::new().connect_mocked_client(asserter.clone());
    for failed in [false, true] {
        push_chain_state(&asserter, Address::ZERO, Some(Address::ZERO));
        let mut pending = store.load().unwrap().unwrap();
        let result = finish_pending(&mut pending, &store, &rt, &provider, |request| {
            assert_eq!(request, id);
            if failed { bail!("temporary prover status failure") }
            Ok(None)
        });
        assert_eq!(result.is_err(), failed);
        assert_eq!(store.load().unwrap().unwrap().request_id, Some(id));
    }
}

#[test]
fn submission_failure_and_restart_reuse_the_paid_proof() {
    let files = TestStore::new();
    let rt = tokio::runtime::Runtime::new().unwrap();
    let mut pending = batch();
    pending.request_id = Some(B256::repeat_byte(5));
    let store = files.open();
    store.save(&pending).unwrap();
    drop(store);
    let mut polls = 0;
    for _ in 0..2 {
        let store = files.open();
        let mut pending = store.load().unwrap().unwrap();
        let asserter = Asserter::new();
        let provider = ProviderBuilder::new().connect_mocked_client(asserter.clone());
        push_chain_state(&asserter, Address::ZERO, Some(Address::ZERO));
        asserter.push_failure_msg("Ethereum submission unavailable");
        assert!(finish_pending(&mut pending, &store, &rt, &provider, |_| {
            polls += 1;
            assert_eq!(polls, 1, "must reuse the saved proof after restarting");
            Ok(Some(saved_proof()))
        }).is_err());
        let saved = store.load().unwrap().unwrap();
        assert_eq!(saved.proof.unwrap().proof, saved_proof().proof);
        assert!(saved.submitted.is_none());
    }
}

#[test]
fn submitted_transaction_is_durable_and_cannot_be_sent_twice() {
    let files = TestStore::new();
    let store = files.open();
    let mut pending = batch();
    pending.proof = Some(saved_proof());
    store.submit(&mut pending, |_| {
        assert!(store.load().unwrap().unwrap().proof.is_some());
        Ok(B256::repeat_byte(7))
    }).unwrap();
    drop(store);
    let store = files.open();
    let mut pending = store.load().unwrap().unwrap();
    assert_eq!(pending.submitted.as_ref().unwrap().hash, B256::repeat_byte(7));
    assert!(store.submit(&mut pending, |_| panic!("must not send twice")).is_err());
}

#[test]
fn unfinalized_results_and_reorganizations_do_not_discard_the_job() {
    let files = TestStore::new();
    let store = files.open();
    let mut pending = batch();
    pending.request_id = Some(B256::repeat_byte(5));
    store.save(&pending).unwrap();
    let rt = tokio::runtime::Runtime::new().unwrap();
    let asserter = Asserter::new();
    let provider = ProviderBuilder::new().connect_mocked_client(asserter.clone());

    push_chain_state(&asserter, Address::ZERO, Some(Address::repeat_byte(1)));
    finish_pending(&mut pending, &store, &rt, &provider, |_| panic!("already proven at latest")).unwrap();
    assert!(store.load().unwrap().is_some());

    push_chain_state(&asserter, Address::ZERO, Some(Address::ZERO));
    let mut polled = false;
    finish_pending(&mut pending, &store, &rt, &provider, |_| { polled = true; Ok(None) }).unwrap();
    assert!(polled, "reorganization must resume the existing request");
    assert!(store.load().unwrap().is_some());

    push_chain_state(&asserter, Address::repeat_byte(1), None);
    finish_pending(&mut pending, &store, &rt, &provider, |_| panic!("finalized")).unwrap();
    assert!(store.load().unwrap().is_none());
}

#[test]
fn proven_reads_are_bounded_batches_and_are_not_cached() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let asserter = Asserter::new();
    let provider = ProviderBuilder::new().connect_mocked_client(asserter.clone());
    let ids: Vec<_> = (0..205).collect();
    let expected: Vec<_> = ids.iter().map(|id| Address::repeat_byte(*id as u8)).collect();
    for chunk in expected.chunks(100) { push_recipients(&asserter, chunk); }
    let got = rt.block_on(proven_recipients(&provider, Address::ZERO, &ids, BlockId::latest())).unwrap();
    assert_eq!(got, expected);
    assert!(asserter.read_q().is_empty(), "205 reads should use exactly three RPC calls");
    push_recipients(&asserter, &[Address::ZERO]);
    assert_eq!(rt.block_on(proven_recipients(&provider, Address::ZERO, &[1], BlockId::latest())).unwrap(), vec![Address::ZERO]);
}

#[test]
fn store_is_exclusive_and_rejects_a_different_deployment() {
    let files = TestStore::new();
    let _store = files.open();
    assert!(state::Store::open(files.0.join("state.json")).is_err());
    let pending = batch();
    assert!(pending.check_identity(2, pending.bridge, &pending.escrow, pending.vkey).is_err());
    assert!(pending.check_identity(1, Address::ZERO, &pending.escrow, pending.vkey).is_err());
    assert!(pending.check_identity(1, pending.bridge, "another escrow", pending.vkey).is_err());
    assert!(pending.check_identity(1, pending.bridge, &pending.escrow, B256::ZERO).is_err());
}

#[test]
fn recovery_cannot_overwrite_an_existing_request() {
    let mut pending = batch();
    let id = B256::repeat_byte(5);
    pending.recover_request_id(id).unwrap();
    pending.recover_request_id(id).unwrap();
    assert!(pending.recover_request_id(B256::repeat_byte(6)).is_err());
    assert_eq!(pending.request_id, Some(id));
}
