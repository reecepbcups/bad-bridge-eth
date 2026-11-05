//! Bad Bridge escrow. Holds cw721 tokens sent to it and records the Ethereum recipient
//! under a raw key that BadBridge.sol can parse straight out of an SP1 membership proof.

use cosmwasm_schema::cw_serde;
use cosmwasm_std::{
    entry_point, to_json_binary, Addr, Binary, Deps, DepsMut, Env, HexBinary, MessageInfo,
    Response, StdResult, WasmMsg,
};
use cw_storage_plus::Item;

/// Raw record key prefix. Full key is `b"b" || token_id (u32 BE)`, value is the 20-byte ETH address.
/// This exact layout is what BadBridge.sol's SP1 membership proof parses, so it must never change.
pub const RECORD_PREFIX: u8 = b'b';
/// Original Cosmos sender per token id, for EmergencyUnlock refunds. Kept under its own prefix
/// so it never appears in the record BadBridge.sol proves membership against.
pub const SENDER_PREFIX: u8 = b's';

const CW721: Item<Addr> = Item::new("cw721");

#[derive(thiserror::Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] cosmwasm_std::StdError),
    #[error("only {expected} can send nfts here")]
    WrongCollection { expected: Addr },
    #[error("token id {0} is not a u32")]
    BadTokenId(String),
    #[error("recipient must be exactly 20 bytes, got {0}")]
    BadRecipient(usize),
    #[error("recipient must not be the zero address")]
    ZeroRecipient,
    #[error("token {0} already bridged")]
    AlreadyBridged(u32),
    #[error("unauthorized")]
    Unauthorized,
    #[error("token {0} is not currently escrowed")]
    NotEscrowed(u32),
}

#[cw_serde]
pub struct InstantiateMsg {
    pub cw721: String,
}

/// cw721 receiver hook payload, inlined to avoid depending on a specific cw721 version.
#[cw_serde]
pub struct Cw721ReceiveMsg {
    pub sender: String,
    pub token_id: String,
    /// raw 20-byte Ethereum recipient
    pub msg: Binary,
}

#[cw_serde]
pub enum ExecuteMsg {
    ReceiveNft(Cw721ReceiveMsg),
    /// CosmWasm admin only. Returns the given escrowed tokens to the Cosmos address that sent them,
    /// bypassing the Ethereum leg entirely. Only safe if the Eureka client stored no Hub root
    /// since the token was sent. Checking BadBridge.sol's `Proven` events isn't enough: any
    /// stored root still proves the old record after the refund, minting the same token twice
    /// across chains (see `adminLive` in spec/badbridge.qnt). The refund goes to whoever called
    /// send_nft, which can be an approved operator instead of the owner.
    EmergencyUnlock { token_ids: Vec<u32> },
}

/// cw721 TransferNft payload, inlined for the same reason as Cw721ReceiveMsg above.
#[cw_serde]
enum Cw721ExecuteMsg {
    TransferNft { recipient: String, token_id: String },
}

#[cw_serde]
pub enum QueryMsg {
    Record { token_id: u32 },
    /// Bridged records in token id order, for the batcher.
    Pending { start_after: Option<u32>, limit: Option<u32> },
    Config {},
}

#[cw_serde]
pub struct PendingRecord {
    pub token_id: u32,
    pub eth_recipient: HexBinary,
}

const DEFAULT_LIMIT: u32 = 100;
const MAX_LIMIT: u32 = 500;

pub fn record_key(token_id: u32) -> Vec<u8> {
    let mut k = Vec::with_capacity(5);
    k.push(RECORD_PREFIX);
    k.extend_from_slice(&token_id.to_be_bytes());
    k
}

pub fn sender_key(token_id: u32) -> Vec<u8> {
    let mut k = Vec::with_capacity(5);
    k.push(SENDER_PREFIX);
    k.extend_from_slice(&token_id.to_be_bytes());
    k
}

#[entry_point]
pub fn instantiate(deps: DepsMut, _env: Env, _info: MessageInfo, msg: InstantiateMsg) -> Result<Response, ContractError> {
    let cw721 = deps.api.addr_validate(&msg.cw721)?;
    CW721.save(deps.storage, &cw721)?;
    Ok(Response::new().add_attribute("cw721", cw721))
}

#[entry_point]
pub fn execute(deps: DepsMut, env: Env, info: MessageInfo, msg: ExecuteMsg) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::ReceiveNft(rcv) => receive_nft(deps, info, rcv),
        ExecuteMsg::EmergencyUnlock { token_ids } => emergency_unlock(deps, env, info, token_ids),
    }
}

fn receive_nft(deps: DepsMut, info: MessageInfo, rcv: Cw721ReceiveMsg) -> Result<Response, ContractError> {
    let expected = CW721.load(deps.storage)?;
    if info.sender != expected {
        return Err(ContractError::WrongCollection { expected });
    }
    // "+7012" and "07012" also parse to 7012, only the canonical form may claim the slot
    let token_id: u32 = rcv
        .token_id
        .parse()
        .ok()
        .filter(|id: &u32| id.to_string() == rcv.token_id)
        .ok_or_else(|| ContractError::BadTokenId(rcv.token_id.clone()))?;
    // a malformed address strands the nft forever, so fail the send instead
    if rcv.msg.len() != 20 {
        return Err(ContractError::BadRecipient(rcv.msg.len()));
    }
    // BadBridge reads a zero recipient as unproven, so it could never be claimed
    if rcv.msg.iter().all(|b| *b == 0) {
        return Err(ContractError::ZeroRecipient);
    }
    let key = record_key(token_id);
    if deps.storage.get(&key).is_some() {
        return Err(ContractError::AlreadyBridged(token_id));
    }
    deps.storage.set(&key, rcv.msg.as_slice());
    deps.storage.set(&sender_key(token_id), rcv.sender.as_bytes());

    Ok(Response::new()
        .add_attribute("action", "bridge")
        .add_attribute("token_id", token_id.to_string())
        .add_attribute("from", rcv.sender)
        .add_attribute("eth_recipient", HexBinary::from(rcv.msg.as_slice()).to_hex()))
}

/// Admin-only escape hatch. See ExecuteMsg::EmergencyUnlock for the double-spend caveat. All-or-
/// nothing over `token_ids`: an id that isn't currently escrowed fails the whole call, so a typo
/// can't silently unlock a different set than the admin intended.
fn emergency_unlock(deps: DepsMut, env: Env, info: MessageInfo, token_ids: Vec<u32>) -> Result<Response, ContractError> {
    ensure_admin(deps.as_ref(), &env, &info)?;
    let cw721 = CW721.load(deps.storage)?;

    let mut msgs = Vec::with_capacity(token_ids.len());
    for token_id in &token_ids {
        let skey = sender_key(*token_id);
        let sender = deps.storage.get(&skey).ok_or(ContractError::NotEscrowed(*token_id))?;
        let recipient = String::from_utf8(sender)
            .map_err(|_| cosmwasm_std::StdError::generic_err(format!("corrupt sender record for token {token_id}")))?;

        deps.storage.remove(&record_key(*token_id));
        deps.storage.remove(&skey);

        msgs.push(WasmMsg::Execute {
            contract_addr: cw721.to_string(),
            msg: to_json_binary(&Cw721ExecuteMsg::TransferNft { recipient, token_id: token_id.to_string() })?,
            funds: vec![],
        });
    }

    Ok(Response::new()
        .add_attribute("action", "emergency_unlock")
        .add_attribute("count", token_ids.len().to_string())
        .add_messages(msgs))
}

// the chain's CosmWasm admin, so clear-contract-admin disables EmergencyUnlock forever
fn ensure_admin(deps: Deps, env: &Env, info: &MessageInfo) -> Result<(), ContractError> {
    match deps.querier.query_wasm_contract_info(&env.contract.address)?.admin {
        Some(admin) if admin == info.sender => Ok(()),
        _ => Err(ContractError::Unauthorized),
    }
}

#[entry_point]
pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::Record { token_id } => {
            to_json_binary(&deps.storage.get(&record_key(token_id)).map(HexBinary::from))
        }
        QueryMsg::Pending { start_after, limit } => to_json_binary(&pending(deps, start_after, limit)),
        QueryMsg::Config {} => to_json_binary(&CW721.load(deps.storage)?),
    }
}

fn pending(deps: Deps, start_after: Option<u32>, limit: Option<u32>) -> Vec<PendingRecord> {
    let limit = limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT) as usize;
    let start = start_after.map_or_else(|| vec![RECORD_PREFIX], |id| {
        let mut k = record_key(id);
        k.push(0); // exclusive of start_after
        k
    });
    let end = vec![RECORD_PREFIX + 1];
    deps.storage
        .range(Some(&start), Some(&end), cosmwasm_std::Order::Ascending)
        .take(limit)
        .map(|(k, v)| PendingRecord {
            token_id: u32::from_be_bytes(k[1..5].try_into().expect("record keys are 5 bytes")),
            eth_recipient: HexBinary::from(v),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::testing::{message_info, mock_dependencies, mock_env, MockApi, MockQuerier};
    use cosmwasm_std::{ContractInfoResponse, ContractResult, MemoryStorage, OwnedDeps, Storage, SystemResult, WasmQuery};

    type MockDeps = OwnedDeps<MemoryStorage, MockApi, MockQuerier>;

    fn setup() -> (MockDeps, Addr, Addr) {
        let mut deps = mock_dependencies();
        let cw721 = deps.api.addr_make("cw721");
        let admin = deps.api.addr_make("admin");
        instantiate(deps.as_mut(), mock_env(), message_info(&admin, &[]), InstantiateMsg { cw721: cw721.to_string() })
            .unwrap();
        set_wasm_admin(&mut deps, Some(admin.clone()));
        (deps, cw721, admin)
    }

    // stands in for wasmd's contract info, which is where the admin lives
    fn set_wasm_admin(deps: &mut MockDeps, admin: Option<Addr>) {
        let me = mock_env().contract.address;
        deps.querier.update_wasm(move |q| match q {
            WasmQuery::ContractInfo { contract_addr } if *contract_addr == me.as_str() => {
                let info = ContractInfoResponse::new(1, me.clone(), admin.clone(), false, None);
                SystemResult::Ok(ContractResult::Ok(to_json_binary(&info).unwrap()))
            }
            _ => panic!("unexpected wasm query {q:?}"),
        });
    }

    fn rcv(token_id: &str, msg: &[u8]) -> ExecuteMsg {
        rcv_from("holder", token_id, msg)
    }

    fn rcv_from(sender: &str, token_id: &str, msg: &[u8]) -> ExecuteMsg {
        ExecuteMsg::ReceiveNft(Cw721ReceiveMsg { sender: sender.into(), token_id: token_id.into(), msg: Binary::from(msg) })
    }

    #[test]
    fn receive_nft() {
        let eth = [0xab; 20];
        let other = [0u8; 19];
        let cases: Vec<(&str, &str, &[u8], Option<ContractError>)> = vec![
            ("ok", "7012", &eth, None),
            ("short recipient", "1", &other, Some(ContractError::BadRecipient(19))),
            ("non numeric id", "abc", &eth, Some(ContractError::BadTokenId("abc".into()))),
            ("plus sign id", "+7012", &eth, Some(ContractError::BadTokenId("+7012".into()))),
            ("leading zero id", "07012", &eth, Some(ContractError::BadTokenId("07012".into()))),
            ("zero recipient", "1", &[0u8; 20], Some(ContractError::ZeroRecipient)),
        ];
        for (name, id, msg, want) in cases {
            let (mut deps, cw721, _admin) = setup();
            let got = execute(deps.as_mut(), mock_env(), message_info(&cw721, &[]), rcv(id, msg));
            match want {
                None => {
                    got.unwrap();
                    assert_eq!(deps.storage.get(&record_key(id.parse().unwrap())).unwrap(), msg, "{name}");
                }
                Some(e) => assert_eq!(got.unwrap_err(), e, "{name}"),
            }
        }
    }

    #[test]
    fn rejects_wrong_collection_and_replays() {
        let (mut deps, cw721, _admin) = setup();
        let stranger = deps.api.addr_make("stranger");
        let err = execute(deps.as_mut(), mock_env(), message_info(&stranger, &[]), rcv("1", &[1; 20])).unwrap_err();
        assert_eq!(err, ContractError::WrongCollection { expected: cw721.clone() });

        execute(deps.as_mut(), mock_env(), message_info(&cw721, &[]), rcv("1", &[1; 20])).unwrap();
        let err = execute(deps.as_mut(), mock_env(), message_info(&cw721, &[]), rcv("1", &[2; 20])).unwrap_err();
        assert_eq!(err, ContractError::AlreadyBridged(1));
    }

    #[test]
    fn pending_pages_in_token_order() {
        let (mut deps, cw721, _admin) = setup();
        for id in ["5", "1", "7012", "3"] {
            execute(deps.as_mut(), mock_env(), message_info(&cw721, &[]), rcv(id, &[1; 20])).unwrap();
        }
        let ids = |start_after, limit| -> Vec<u32> {
            pending(deps.as_ref(), start_after, limit).into_iter().map(|r| r.token_id).collect()
        };
        assert_eq!(ids(None, None), vec![1, 3, 5, 7012]);
        assert_eq!(ids(Some(3), Some(1)), vec![5]);
        assert_eq!(ids(Some(7012), None), Vec::<u32>::new());
        // the config item must never show up as a record
        assert!(pending(deps.as_ref(), None, None).iter().all(|r| r.eth_recipient.len() == 20));
    }

    #[test]
    fn only_canonical_token_ids() {
        let (mut deps, cw721, _admin) = setup();
        // xorshift, deterministic without pulling in a rand dep
        let mut seed = 0x9e37_79b9_7f4a_7c15u64;
        for _ in 0..2000 {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            let id = seed as u32;
            for bad in [format!("+{id}"), format!("0{id}"), format!("00{id}"), format!(" {id}"), format!("{id} ")] {
                let err = execute(deps.as_mut(), mock_env(), message_info(&cw721, &[]), rcv(&bad, &[1; 20])).unwrap_err();
                assert_eq!(err, ContractError::BadTokenId(bad));
            }
            // skip the rare repeat so AlreadyBridged doesn't mask the check
            if deps.storage.get(&record_key(id)).is_none() {
                execute(deps.as_mut(), mock_env(), message_info(&cw721, &[]), rcv(&id.to_string(), &[1; 20])).unwrap();
            }
        }
    }

    #[test]
    fn record_key_layout() {
        assert_eq!(record_key(7012), vec![b'b', 0x00, 0x00, 0x1b, 0x64]);
    }

    #[test]
    fn emergency_unlock_requires_admin() {
        let (mut deps, cw721, _admin) = setup();
        execute(deps.as_mut(), mock_env(), message_info(&cw721, &[]), rcv("1", &[1; 20])).unwrap();

        let stranger = deps.api.addr_make("stranger");
        let err = execute(
            deps.as_mut(),
            mock_env(),
            message_info(&stranger, &[]),
            ExecuteMsg::EmergencyUnlock { token_ids: vec![1] },
        )
        .unwrap_err();
        assert_eq!(err, ContractError::Unauthorized);
    }

    #[test]
    fn emergency_unlock_refunds_original_senders_and_clears_records() {
        let (mut deps, cw721, admin) = setup();
        execute(deps.as_mut(), mock_env(), message_info(&cw721, &[]), rcv_from("alice", "1", &[1; 20])).unwrap();
        execute(deps.as_mut(), mock_env(), message_info(&cw721, &[]), rcv_from("bob", "2", &[2; 20])).unwrap();

        let res = execute(
            deps.as_mut(),
            mock_env(),
            message_info(&admin, &[]),
            ExecuteMsg::EmergencyUnlock { token_ids: vec![1, 2] },
        )
        .unwrap();

        let want = [("alice", "1"), ("bob", "2")].map(|(recipient, token_id)| {
            cosmwasm_std::CosmosMsg::Wasm(WasmMsg::Execute {
                contract_addr: cw721.to_string(),
                msg: to_json_binary(&Cw721ExecuteMsg::TransferNft { recipient: recipient.into(), token_id: token_id.into() }).unwrap(),
                funds: vec![],
            })
        });
        assert_eq!(res.messages.iter().map(|m| m.msg.clone()).collect::<Vec<_>>(), want);

        for token_id in [1u32, 2] {
            assert!(deps.storage.get(&record_key(token_id)).is_none());
            assert!(deps.storage.get(&sender_key(token_id)).is_none());
        }
        // already unlocked, so no longer escrowed
        let err = execute(
            deps.as_mut(),
            mock_env(),
            message_info(&admin, &[]),
            ExecuteMsg::EmergencyUnlock { token_ids: vec![1] },
        )
        .unwrap_err();
        assert_eq!(err, ContractError::NotEscrowed(1));
    }

    #[test]
    fn emergency_unlock_only_touches_listed_ids() {
        let (mut deps, cw721, admin) = setup();
        for id in ["5", "1", "3"] {
            execute(deps.as_mut(), mock_env(), message_info(&cw721, &[]), rcv_from("holder", id, &[1; 20])).unwrap();
        }
        execute(
            deps.as_mut(),
            mock_env(),
            message_info(&admin, &[]),
            ExecuteMsg::EmergencyUnlock { token_ids: vec![1, 3] },
        )
        .unwrap();
        assert_eq!(
            pending(deps.as_ref(), None, None).into_iter().map(|r| r.token_id).collect::<Vec<_>>(),
            vec![5]
        );
    }

    #[test]
    fn emergency_unlock_rejects_unknown_token_id() {
        let (mut deps, cw721, admin) = setup();
        execute(deps.as_mut(), mock_env(), message_info(&cw721, &[]), rcv("1", &[1; 20])).unwrap();

        let err = execute(
            deps.as_mut(),
            mock_env(),
            message_info(&admin, &[]),
            ExecuteMsg::EmergencyUnlock { token_ids: vec![1, 404] },
        )
        .unwrap_err();
        assert_eq!(err, ContractError::NotEscrowed(404));
    }

    #[test]
    fn cleared_wasm_admin_cannot_unlock() {
        let (mut deps, cw721, admin) = setup();
        execute(deps.as_mut(), mock_env(), message_info(&cw721, &[]), rcv("1", &[1; 20])).unwrap();

        set_wasm_admin(&mut deps, None);

        let err = execute(
            deps.as_mut(),
            mock_env(),
            message_info(&admin, &[]),
            ExecuteMsg::EmergencyUnlock { token_ids: vec![1] },
        )
        .unwrap_err();
        assert_eq!(err, ContractError::Unauthorized);
    }
}
