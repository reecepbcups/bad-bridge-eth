//! Model-based fuzz of the escrow. Random callers fire random messages, and after every step the
//! contract's raw storage has to match a dumb reference model exactly, byte for byte.

use std::collections::BTreeMap;

use bad_bridge_escrow::{
    execute, instantiate, query, record_key, sender_key, ContractError, Cw721ReceiveMsg, ExecuteMsg, InstantiateMsg,
    PendingRecord, QueryMsg,
};
use cosmwasm_schema::cw_serde;
use cosmwasm_std::testing::{message_info, mock_dependencies, mock_env, MockApi, MockQuerier};
use cosmwasm_std::{from_json, Addr, Binary, CosmosMsg, MemoryStorage, Order, OwnedDeps, Storage, WasmMsg};
use proptest::prelude::*;

type Deps = OwnedDeps<MemoryStorage, MockApi, MockQuerier>;

// mirrors the contract's private TransferNft payload
#[cw_serde]
enum Cw721ExecuteMsg {
    TransferNft { recipient: String, token_id: String },
}

#[derive(Debug, Clone, Copy)]
enum Actor {
    Cw721,
    Admin,
    Stranger,
}

#[derive(Debug, Clone)]
enum Op {
    Receive { caller: Actor, sender: u8, token_id: String, recipient: Vec<u8> },
    Unlock { caller: Actor, ids: Vec<u32> },
    Renounce { caller: Actor },
}

#[derive(Default, Clone)]
struct Model {
    // token id to (eth recipient, cosmos sender)
    escrowed: BTreeMap<u32, (Vec<u8>, String)>,
    renounced: bool,
}

struct Env {
    deps: Deps,
    cw721: Addr,
    admin: Addr,
    stranger: Addr,
}

impl Env {
    fn new() -> Self {
        let mut deps = mock_dependencies();
        let cw721 = deps.api.addr_make("cw721");
        let admin = deps.api.addr_make("admin");
        let stranger = deps.api.addr_make("stranger");
        let msg = InstantiateMsg { cw721: cw721.to_string(), admin: admin.to_string() };
        instantiate(deps.as_mut(), mock_env(), message_info(&stranger, &[]), msg).unwrap();
        Env { deps, cw721, admin, stranger }
    }

    fn addr(&self, a: Actor) -> &Addr {
        match a {
            Actor::Cw721 => &self.cw721,
            Actor::Admin => &self.admin,
            Actor::Stranger => &self.stranger,
        }
    }
}

// written from the u32 spec, not with str::parse, so the check isn't the code grading itself
fn canonical_u32(s: &str) -> Option<u32> {
    if s.is_empty() || s.len() > 10 || !s.bytes().all(|b| b.is_ascii_digit()) || (s.len() > 1 && s.starts_with('0')) {
        return None;
    }
    let n = s.bytes().fold(0u64, |n, b| n * 10 + u64::from(b - b'0'));
    u32::try_from(n).ok()
}

fn actor() -> impl Strategy<Value = Actor> {
    prop_oneof![4 => Just(Actor::Cw721), 1 => Just(Actor::Admin), 1 => Just(Actor::Stranger)]
}

// small ids so replays and unlocks of real records happen a lot
fn token_id() -> impl Strategy<Value = String> {
    prop_oneof![
        6 => (0u32..6).prop_map(|n| n.to_string()),
        1 => any::<u32>().prop_map(|n| n.to_string()),
        1 => (0u32..6).prop_map(|n| format!("+{n}")),
        1 => (0u32..6).prop_map(|n| format!("0{n}")),
        1 => (0u32..6).prop_map(|n| format!(" {n}")),
        1 => Just("4294967296".to_string()),
        1 => ".{0,12}",
    ]
}

fn recipient() -> impl Strategy<Value = Vec<u8>> {
    prop_oneof![
        8 => prop::array::uniform20(any::<u8>()).prop_map(|a| a.to_vec()),
        1 => Just(vec![0u8; 20]),
        1 => prop::collection::vec(any::<u8>(), 0..40),
    ]
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        6 => (actor(), 0u8..3, token_id(), recipient())
            .prop_map(|(caller, sender, token_id, recipient)| Op::Receive { caller, sender, token_id, recipient }),
        2 => (actor(), prop::collection::vec(0u32..7, 0..4)).prop_map(|(caller, ids)| Op::Unlock { caller, ids }),
        1 => actor().prop_map(|caller| Op::Renounce { caller }),
    ]
}

/// What the model says should happen. Ok carries the TransferNft msgs an unlock must emit.
fn step(m: &mut Model, op: &Op, cw721: &Addr) -> Result<Vec<(String, String)>, ContractError> {
    match op {
        Op::Receive { caller, sender, token_id, recipient } => {
            if !matches!(caller, Actor::Cw721) {
                return Err(ContractError::WrongCollection { expected: cw721.clone() });
            }
            let id = canonical_u32(token_id).ok_or_else(|| ContractError::BadTokenId(token_id.clone()))?;
            if recipient.len() != 20 {
                return Err(ContractError::BadRecipient(recipient.len()));
            }
            if recipient.iter().all(|b| *b == 0) {
                return Err(ContractError::ZeroRecipient);
            }
            if m.escrowed.contains_key(&id) {
                return Err(ContractError::AlreadyBridged(id));
            }
            m.escrowed.insert(id, (recipient.clone(), format!("holder{sender}")));
            Ok(vec![])
        }
        Op::Unlock { caller, ids } => {
            if !matches!(caller, Actor::Admin) || m.renounced {
                return Err(ContractError::Unauthorized);
            }
            // all or nothing, so work on a copy
            let mut next = m.escrowed.clone();
            let mut out = vec![];
            for id in ids {
                let (_, sender) = next.remove(id).ok_or(ContractError::NotEscrowed(*id))?;
                out.push((sender, id.to_string()));
            }
            m.escrowed = next;
            Ok(out)
        }
        Op::Renounce { caller } => {
            if !matches!(caller, Actor::Admin) || m.renounced {
                return Err(ContractError::Unauthorized);
            }
            m.renounced = true;
            Ok(vec![])
        }
    }
}

fn to_msg(op: &Op) -> ExecuteMsg {
    match op {
        Op::Receive { sender, token_id, recipient, .. } => ExecuteMsg::ReceiveNft(Cw721ReceiveMsg {
            sender: format!("holder{sender}"),
            token_id: token_id.clone(),
            msg: Binary::from(recipient.as_slice()),
        }),
        Op::Unlock { ids, .. } => ExecuteMsg::EmergencyUnlock { token_ids: ids.clone() },
        Op::Renounce { .. } => ExecuteMsg::RenounceAdmin {},
    }
}

fn caller(op: &Op) -> Actor {
    match op {
        Op::Receive { caller, .. } | Op::Unlock { caller, .. } | Op::Renounce { caller } => *caller,
    }
}

/// Runs a message like the chain does: an error throws away every write the message made.
fn exec(env: &mut Env, who: &Addr, msg: ExecuteMsg) -> Result<cosmwasm_std::Response, ContractError> {
    let snapshot: Vec<(Vec<u8>, Vec<u8>)> = env.deps.storage.range(None, None, Order::Ascending).collect();
    let res = execute(env.deps.as_mut(), mock_env(), message_info(who, &[]), msg);
    if res.is_err() {
        let keys: Vec<Vec<u8>> = env.deps.storage.range(None, None, Order::Ascending).map(|(k, _)| k).collect();
        keys.iter().for_each(|k| env.deps.storage.remove(k));
        snapshot.iter().for_each(|(k, v)| env.deps.storage.set(k, v));
    }
    res
}

/// Every key in storage must be one the model accounts for. Catches stray writes and half-cleared records.
fn assert_storage(env: &Env, m: &Model) {
    let mut want: BTreeMap<Vec<u8>, Vec<u8>> = BTreeMap::new();
    want.insert(b"cw721".to_vec(), serde_json_addr(&env.cw721));
    if !m.renounced {
        want.insert(b"admin".to_vec(), serde_json_addr(&env.admin));
    }
    for (id, (recipient, sender)) in &m.escrowed {
        want.insert(record_key(*id), recipient.clone());
        want.insert(sender_key(*id), sender.as_bytes().to_vec());
    }
    let got: BTreeMap<Vec<u8>, Vec<u8>> = env.deps.storage.range(None, None, Order::Ascending).collect();
    assert_eq!(got, want);
}

fn serde_json_addr(a: &Addr) -> Vec<u8> {
    cosmwasm_std::to_json_vec(a).unwrap()
}

fn assert_pending(env: &Env, m: &Model) {
    let raw = query(env.deps.as_ref(), mock_env(), QueryMsg::Pending { start_after: None, limit: Some(500) }).unwrap();
    let got: Vec<PendingRecord> = from_json(raw).unwrap();
    let want: Vec<(u32, Vec<u8>)> = m.escrowed.iter().map(|(id, (r, _))| (*id, r.clone())).collect();
    let got: Vec<(u32, Vec<u8>)> = got.into_iter().map(|p| (p.token_id, p.eth_recipient.to_vec())).collect();
    assert_eq!(got, want);
}

fn transfers(res: &cosmwasm_std::Response, cw721: &Addr) -> Vec<(String, String)> {
    res.messages
        .iter()
        .map(|sub| match &sub.msg {
            CosmosMsg::Wasm(WasmMsg::Execute { contract_addr, msg, funds }) => {
                assert_eq!(contract_addr, cw721.as_str(), "unlock must only ever call the cw721");
                assert!(funds.is_empty());
                let Cw721ExecuteMsg::TransferNft { recipient, token_id } = from_json(msg).unwrap();
                (recipient, token_id)
            }
            other => panic!("unexpected msg {other:?}"),
        })
        .collect()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2000))]

    #[test]
    fn escrow_matches_model(ops in prop::collection::vec(op(), 1..40)) {
        let mut env = Env::new();
        let mut m = Model::default();
        for op in &ops {
            let want = step(&mut m, op, &env.cw721);
            let who = env.addr(caller(op)).clone();
            let got = exec(&mut env, &who, to_msg(op));
            match (got, want) {
                (Ok(res), Ok(want_msgs)) => prop_assert_eq!(transfers(&res, &env.cw721), want_msgs),
                (Err(g), Err(w)) => prop_assert_eq!(g, w),
                (g, w) => prop_assert!(false, "op {:?}: contract {:?}, model {:?}", op, g.map(|_| ()), w.map(|_| ())),
            }
            // the model only moves on success, so this also checks a failed message left no trace
            assert_storage(&env, &m);
            assert_pending(&env, &m);
        }
    }

    /// Only the configured cw721 can create records, whatever the payload.
    #[test]
    fn only_cw721_records(name in "[a-z]{1,10}", token_id in token_id(), recipient in recipient()) {
        let mut env = Env::new();
        let who = env.deps.api.addr_make(&name);
        prop_assume!(who != env.cw721);
        let msg = ExecuteMsg::ReceiveNft(Cw721ReceiveMsg { sender: "holder0".into(), token_id, msg: Binary::from(recipient) });
        let err = execute(env.deps.as_mut(), mock_env(), message_info(&who, &[]), msg).unwrap_err();
        prop_assert!(
            matches!(err, ContractError::WrongCollection { .. }),
            "expected WrongCollection, got {:?}",
            err
        );
        assert_storage(&env, &Model::default());
    }

    /// Only the admin can unlock or renounce, even with ids that are really escrowed.
    #[test]
    fn only_admin_unlocks(name in "[a-z]{1,10}", ids in prop::collection::vec(0u32..3, 0..4)) {
        let mut env = Env::new();
        let who = env.deps.api.addr_make(&name);
        prop_assume!(who != env.admin);
        let mut m = Model::default();
        for id in 0u32..3 {
            let op = Op::Receive { caller: Actor::Cw721, sender: 0, token_id: id.to_string(), recipient: vec![1; 20] };
            step(&mut m, &op, &env.cw721).unwrap();
            execute(env.deps.as_mut(), mock_env(), message_info(&env.cw721.clone(), &[]), to_msg(&op)).unwrap();
        }
        for msg in [ExecuteMsg::EmergencyUnlock { token_ids: ids.clone() }, ExecuteMsg::RenounceAdmin {}] {
            let err = execute(env.deps.as_mut(), mock_env(), message_info(&who, &[]), msg).unwrap_err();
            prop_assert_eq!(err, ContractError::Unauthorized);
        }
        assert_storage(&env, &m);
    }

    /// Pages always stitch together into the full ordered list, whatever the page size.
    #[test]
    fn pending_pages_cover_everything(ids in prop::collection::btree_set(any::<u32>(), 0..30), limit in 1u32..8) {
        let mut env = Env::new();
        for id in &ids {
            let rcv = Cw721ReceiveMsg { sender: "holder0".into(), token_id: id.to_string(), msg: Binary::from([7u8; 20]) };
            execute(env.deps.as_mut(), mock_env(), message_info(&env.cw721.clone(), &[]), ExecuteMsg::ReceiveNft(rcv)).unwrap();
        }
        let mut seen = vec![];
        let mut start_after = None;
        loop {
            let raw = query(env.deps.as_ref(), mock_env(), QueryMsg::Pending { start_after, limit: Some(limit) }).unwrap();
            let page: Vec<PendingRecord> = from_json(raw).unwrap();
            prop_assert!(page.len() <= limit as usize);
            let Some(last) = page.last() else { break };
            start_after = Some(last.token_id);
            seen.extend(page.iter().map(|p| p.token_id));
        }
        prop_assert_eq!(seen, ids.into_iter().collect::<Vec<_>>());
    }
}

#[test]
fn canonical_u32_spec() {
    for (s, want) in [
        ("0", Some(0)),
        ("7012", Some(7012)),
        ("4294967295", Some(u32::MAX)),
        ("4294967296", None),
        ("00", None),
        ("+1", None),
        ("", None),
        ("1 ", None),
        ("１", None),
    ] {
        assert_eq!(canonical_u32(s), want, "{s}");
    }
}
