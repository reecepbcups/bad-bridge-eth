//! One durable job. A failed or interrupted submission must never purchase another proof.

use crate::{ConsensusState, SP1Proof};
use alloy::primitives::{Address, B256};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize, Deserialize)]
pub struct PendingBatch {
    pub chain_id: u64,
    pub bridge: Address,
    pub escrow: String,
    pub height: u64,
    pub cs: ConsensusState,
    pub token_ids: Vec<u32>,
    pub vkey: B256,
    pub request_id: Option<B256>,
    pub proof: Option<SP1Proof>,
    pub submitted: Option<Submitted>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Submitted {
    pub hash: B256,
    pub sent_at: u64,
}

impl PendingBatch {
    pub fn recover_request_id(&mut self, id: B256) -> Result<()> {
        if self.request_id.is_some_and(|existing| existing != id) {
            bail!("cannot replace the saved prover request ID");
        }
        self.request_id = Some(id);
        Ok(())
    }

    pub fn check_identity(&self, chain_id: u64, bridge: Address, escrow: &str, vkey: B256) -> Result<()> {
        if (self.chain_id, self.bridge, self.escrow.as_str(), self.vkey) != (chain_id, bridge, escrow, vkey) {
            bail!("saved batch belongs to another chain, bridge, escrow or proving key; use its original configuration");
        }
        Ok(())
    }
}

pub struct Store {
    path: PathBuf,
    // The OS releases this lock on exit, including a crash.
    _lock: File,
}

impl Store {
    pub fn open(path: PathBuf) -> Result<Self> {
        let parent = parent(&path);
        fs::create_dir_all(parent)?;
        let mut lock_path = path.as_os_str().to_os_string();
        lock_path.push(".lock");
        let lock = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(lock_path)?;
        lock.try_lock().context("another batcher is using this state file")?;
        Ok(Self { path, _lock: lock })
    }

    pub fn load(&self) -> Result<Option<PendingBatch>> {
        match fs::read(&self.path) {
            Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes).context("invalid saved batch; refusing to purchase another proof")?)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    pub fn save(&self, batch: &PendingBatch) -> Result<()> {
        let mut temp = self.path.as_os_str().to_os_string();
        temp.push(".tmp");
        let mut file = File::create(&temp)?;
        file.write_all(&serde_json::to_vec_pretty(batch)?)?;
        file.sync_all()?;
        fs::rename(temp, &self.path)?;
        File::open(parent(&self.path))?.sync_all()?;
        Ok(())
    }

    pub fn clear(&self) -> Result<()> {
        fs::remove_file(&self.path)?;
        File::open(parent(&self.path))?.sync_all()?;
        Ok(())
    }

    pub fn request(&self, mut batch: PendingBatch, request: impl FnOnce() -> Result<B256>) -> Result<PendingBatch> {
        if self.load()?.is_some() {
            bail!("a saved batch must be resolved before requesting another proof");
        }
        // Save before paying. If acceptance is ambiguous, an operator must recover the request ID.
        self.save(&batch)?;
        let id = request().context("proof request outcome may be unknown; preserve the saved batch and recover its request ID")?;
        tracing::info!(request_id = %id, "proof requested; saving request id");
        batch.request_id = Some(id);
        self.save(&batch)?;
        Ok(batch)
    }

    pub fn submit(&self, batch: &mut PendingBatch, send: impl FnOnce(&PendingBatch) -> Result<B256>) -> Result<()> {
        if batch.proof.is_none() || batch.submitted.is_some() {
            bail!("saved batch must have a proof and no outstanding transaction");
        }
        self.save(batch)?;
        let hash = send(batch)?;
        tracing::info!(tx = %hash, "batch transaction sent; saving transaction hash");
        batch.submitted = Some(Submitted { hash, sent_at: now()? });
        self.save(batch)
    }
}

fn parent(path: &Path) -> &Path {
    path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."))
}

pub fn now() -> Result<u64> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs())
}
