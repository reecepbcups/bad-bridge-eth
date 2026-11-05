//! Cosmos Hub reads: escrow records over REST, proofs and headers over CometBFT RPC.

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Deserialize;
use std::time::Duration;

pub struct Hub {
    http: reqwest::blocking::Client,
    /// tried in order, the first one that still has the height wins
    rpcs: Vec<String>,
    rest: String,
}

#[derive(Deserialize)]
pub struct Record {
    pub token_id: u32,
    pub eth_recipient: String,
}

/// A proven escrow record: the raw store key/value plus its ICS-23 proof.
pub struct ProvenRecord {
    pub token_id: u32,
    pub store_key: Vec<u8>,
    pub value: Vec<u8>,
    /// protobuf ibc.core.commitment.v1.MerkleProof
    pub merkle_proof: Vec<u8>,
}

pub struct Header {
    pub timestamp_ns: u128,
    pub app_hash: [u8; 32],
    pub next_validators_hash: [u8; 32],
}

impl Hub {
    pub fn new(rpcs: Vec<String>, rest: String) -> Result<Self> {
        if rpcs.is_empty() || rpcs.iter().any(|rpc| rpc.is_empty()) {
            bail!("at least one nonempty hub rpc is required");
        }
        let http = reqwest::blocking::Client::builder().timeout(Duration::from_secs(30)).build()?;
        Ok(Self { http, rpcs, rest })
    }

    /// Every record in the escrow, paging through the `pending` query.
    pub fn records(&self, escrow: &str) -> Result<Vec<Record>> {
        let mut out: Vec<Record> = Vec::new();
        loop {
            let start_after = out.last().map_or("null".to_string(), |r| r.token_id.to_string());
            let q = format!(r#"{{"pending":{{"start_after":{start_after},"limit":500}}}}"#);
            let url = format!("{}/cosmwasm/wasm/v1/contract/{escrow}/smart/{}", self.rest, B64.encode(q));
            #[derive(Deserialize)]
            struct Resp {
                data: Vec<Record>,
            }
            let page: Resp = self.http.get(&url).send()?.error_for_status()?.json().context("decode pending")?;
            let done = page.data.len() < 500;
            out.extend(page.data);
            if done {
                return Ok(out);
            }
        }
    }

    /// Proves `store_key` in the wasm store at `height`. Ok(None) if the key isn't there yet.
    pub fn prove(&self, store_key: &[u8], height: u64) -> Result<Option<(Vec<u8>, Vec<u8>)>> {
        let mut last_err = anyhow!("no hub rpcs configured");
        for rpc in &self.rpcs {
            match self.prove_at(rpc, store_key, height) {
                Ok(r) => return Ok(r),
                Err(e) => {
                    tracing::warn!(rpc, height, error = %e, "abci_query failed, trying next rpc");
                    last_err = e;
                }
            }
        }
        Err(last_err)
    }

    fn prove_at(&self, rpc: &str, store_key: &[u8], height: u64) -> Result<Option<(Vec<u8>, Vec<u8>)>> {
        let url = format!(
            "{rpc}/abci_query?path=%22/store/wasm/key%22&data=0x{}&height={height}&prove=true",
            hex::encode(store_key)
        );
        let v: serde_json::Value = self.http.get(&url).send()?.error_for_status()?.json()?;
        let result = rpc_result(&v)?;
        let resp = result.get("response").filter(|r| r.is_object()).context("missing ABCI response")?;
        let code = resp["code"].as_u64().context("missing ABCI response code")?;
        if code != 0 {
            bail!("abci code {}: {}", resp["code"], resp["log"]);
        }
        let response_height: u64 = resp["height"].as_str().context("missing ABCI height")?.parse()?;
        if response_height != height {
            bail!("ABCI height {response_height} != requested {height}");
        }
        let value = match resp.get("value") {
            Some(serde_json::Value::Null) => Vec::new(),
            Some(serde_json::Value::String(value)) => B64.decode(value)?,
            _ => bail!("missing or invalid ABCI value"),
        };
        if value.is_empty() {
            return Ok(None);
        }
        let ops = resp["proofOps"]["ops"].as_array().ok_or_else(|| anyhow!("no proof ops"))?;
        if ops.len() != 2 {
            bail!("expected 2 proof ops (iavl, simple), got {}", ops.len());
        }
        // MerkleProof { repeated CommitmentProof proofs = 1 }, each op's data is already a CommitmentProof
        let mut mp = Vec::new();
        for op in ops {
            let data = B64.decode(op["data"].as_str().ok_or_else(|| anyhow!("op without data"))?)?;
            mp.push(0x0a);
            put_varint(&mut mp, data.len() as u64);
            mp.extend_from_slice(&data);
        }
        Ok(Some((value, mp)))
    }

    pub fn header(&self, height: u64) -> Result<Header> {
        let mut last_err = anyhow!("no hub rpcs configured");
        for rpc in &self.rpcs {
            match self.header_at(rpc, height) {
                Ok(header) => return Ok(header),
                Err(e) => {
                    tracing::warn!(rpc, height, error = %e, "header failed, trying next rpc");
                    last_err = e;
                }
            }
        }
        Err(last_err)
    }

    fn header_at(&self, rpc: &str, height: u64) -> Result<Header> {
        let url = format!("{rpc}/block?height={height}");
        let v: serde_json::Value = self.http.get(&url).send()?.error_for_status()?.json()?;
        let h = &rpc_result(&v)?["block"]["header"];
        let response_height: u64 = h["height"].as_str().context("missing header height")?.parse()?;
        if response_height != height {
            bail!("header height {response_height} != requested {height}");
        }
        let time = chrono::DateTime::parse_from_rfc3339(h["time"].as_str().context("missing header time")?)
            .with_context(|| format!("parse header time at {height}"))?;
        let ns = time.timestamp_nanos_opt().ok_or_else(|| anyhow!("header time out of range"))?;
        Ok(Header {
            timestamp_ns: u128::try_from(ns)?,
            app_hash: hex32(&h["app_hash"])?,
            next_validators_hash: hex32(&h["next_validators_hash"])?,
        })
    }
}

fn rpc_result(v: &serde_json::Value) -> Result<&serde_json::Value> {
    if let Some(error) = v.get("error").filter(|e| !e.is_null()) {
        bail!("Hub JSON-RPC error: {error}");
    }
    v.get("result").filter(|r| r.is_object()).context("missing Hub JSON-RPC result")
}

/// A newer low-numbered deposit must not prevent an older record from joining the batch.
pub fn eligible_batch(
    records: &[Record],
    escrow_raw: &[u8; 32],
    max_batch: usize,
    mut prove: impl FnMut(&[u8]) -> Result<Option<(Vec<u8>, Vec<u8>)>>,
) -> Result<Vec<ProvenRecord>> {
    let mut batch = Vec::new();
    for r in records {
        if batch.len() == max_batch {
            break;
        }
        let key = store_key(escrow_raw, r.token_id);
        if let Some((value, merkle_proof)) = prove(&key)? {
            if hex::encode(&value) != r.eth_recipient.to_lowercase() {
                bail!("token {}: proven value {} != escrow record {}", r.token_id, hex::encode(&value), r.eth_recipient);
            }
            batch.push(ProvenRecord { token_id: r.token_id, store_key: key, value, merkle_proof });
        }
    }
    Ok(batch)
}

/// `0x03 || escrow addr || b"b" || token_id BE`, the wasmd contract store key of a record.
pub fn store_key(escrow_raw: &[u8; 32], token_id: u32) -> Vec<u8> {
    let mut k = Vec::with_capacity(38);
    k.push(0x03);
    k.extend_from_slice(escrow_raw);
    k.push(b'b');
    k.extend_from_slice(&token_id.to_be_bytes());
    k
}

pub fn escrow_raw(bech: &str) -> Result<[u8; 32]> {
    let (_, data) = bech32::decode(bech).with_context(|| format!("decode {bech}"))?;
    data.try_into().map_err(|d: Vec<u8>| anyhow!("escrow address is {} bytes, want 32", d.len()))
}

fn hex32(v: &serde_json::Value) -> Result<[u8; 32]> {
    let b = hex::decode(v.as_str().unwrap_or(""))?;
    b.try_into().map_err(|_| anyhow!("want 32 bytes"))
}

fn put_varint(out: &mut Vec<u8>, mut n: u64) {
    while n >= 0x80 {
        out.push((n as u8) | 0x80);
        n >>= 7;
    }
    out.push(n as u8);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};

    fn server(body: &str) -> (String, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let body = body.to_string();
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                let mut buf = [0; 8192];
                let _ = stream.read(&mut buf);
                count.fetch_add(1, Ordering::SeqCst);
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
            }
        });
        (format!("http://{address}"), calls)
    }

    const VALID: &str = r#"{"result":{"response":{"code":0,"height":"123","value":"AQ==","proofOps":{"ops":[{"data":"AQ=="},{"data":"Ag=="}]}},"block":{"header":{"height":"124","time":"2026-11-05T00:00:00Z","app_hash":"0000000000000000000000000000000000000000000000000000000000000000","next_validators_hash":"0000000000000000000000000000000000000000000000000000000000000000"}}}}"#;

    #[test]
    fn rpc_errors_and_malformed_responses_try_the_backup() {
        for invalid in [
            r#"{"error":{"code":-32603,"message":"height unavailable"}}"#,
            r#"{}"#,
            r#"{"result":{"response":{}}}"#,
            r#"{"result":{"response":{"code":0,"height":"123"}}}"#,
            r#"{"result":{"response":{"code":0,"height":"122","value":null}}}"#,
        ] {
            let (bad, bad_calls) = server(invalid);
            let (good, good_calls) = server(VALID);
            let hub = Hub::new(vec![bad, good], String::new()).unwrap();
            let (value, proof) = hub.prove(&[3, 4], 123).unwrap().unwrap();
            assert_eq!(value, vec![1]);
            assert_eq!(proof, vec![10, 1, 1, 10, 1, 2]);
            assert!(hub.header(124).is_ok());
            assert_eq!(bad_calls.load(Ordering::SeqCst), 2);
            assert_eq!(good_calls.load(Ordering::SeqCst), 2);
        }
    }

    #[test]
    fn genuine_absence_does_not_query_another_provider() {
        let (missing, _) = server(r#"{"result":{"response":{"code":0,"height":"123","value":null}}}"#);
        let (good, calls) = server(VALID);
        let hub = Hub::new(vec![missing, good], String::new()).unwrap();
        assert!(hub.prove(&[3], 123).unwrap().is_none());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn batch_limit_counts_eligible_records_and_stops_when_full() {
        let records: Vec<_> = [1, 2, 100, 101].into_iter().map(|token_id| Record { token_id, eth_recipient: "01".into() }).collect();
        let mut checked = Vec::new();
        let batch = eligible_batch(&records, &[0; 32], 1, |key| {
            let id = u32::from_be_bytes(key[34..].try_into().unwrap());
            checked.push(id);
            Ok((id >= 100).then(|| (vec![1], vec![2])))
        }).unwrap();
        assert_eq!(checked, vec![1, 2, 100]);
        assert_eq!(batch.iter().map(|r| r.token_id).collect::<Vec<_>>(), vec![100]);
    }

    #[test]
    fn a_failed_or_mismatched_proof_is_not_paid_for() {
        let records = [Record { token_id: 1, eth_recipient: "01".into() }];
        assert!(eligible_batch(&records, &[0; 32], 1, |_| bail!("rpc unavailable")).is_err());
        assert!(eligible_batch(&records, &[0; 32], 1, |_| Ok(Some((vec![2], vec![3])))).is_err());
    }
}
