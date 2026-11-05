# Batcher

Run with `BRIDGE`, `ESCROW`, `MEMBERSHIP_ELF`, `ETH_PRIVATE_KEY` and
`NETWORK_PRIVATE_KEY` set, then `cargo run --locked --release`. `ESCROW` is the
Cosmos address; startup checks its bytes against the Ethereum bridge.

Set `BATCHER_STATE` to a file on persistent storage, for example
`/var/lib/bad-bridge/batcher-state.json`. The default is `batcher-state.json` in
the working directory. Keep this file across restarts and deployments. One
batcher may use it at a time; an OS file lock enforces that rule. The file
contains public proof/transaction data, never private keys.

Each pass resumes the saved job before creating another batch. The job records
the prover request ID, completed proof and submitted Ethereum transaction.
Submission failures retry the saved proof. A transaction that has disappeared
from the RPC for at least 20 minutes can be resubmitted using the same proof.
The job is cleared only when all its records exist in finalized Ethereum state.
This deliberately processes one batch at a time through finality.

If Ethereum accepts a broadcast but its response is lost before the transaction
hash is saved, a retry can spend additional Ethereum gas. The completed proof
is retained in this case; it is never purchased again.

`POLL_SECS` defaults to 60 and `MAX_BATCH` to 50. `ONCE=1` performs one pass,
which may only request or poll a proof; subsequent passes resume it. Errors
return a nonzero exit status in this mode. Ethereum record reads use Multicall3
in groups of 100, with fresh reads rather than a cache of unconfirmed results.

## Recovering an interrupted proof request

The batcher saves an intent before contacting the paid proving service. A crash
or connection error can leave it uncertain whether the request was accepted.
In this case it stops requesting proofs instead of risking a second charge.

Find the request in the prover explorer (the request ID is also logged as soon
as it is returned), and restart with `RECOVER_REQUEST_ID=0x...` set to that
existing request. This command saves the ID and exits. Restart without this
environment variable to resume normal work, so it cannot be reused for a later job.
Never use an unrelated request ID or delete the job merely because a provider
is unavailable.

If the prover confirms that no request was accepted, or that the recorded
request has permanently failed and cannot complete, stop the batcher and
archive its state file before explicitly starting a replacement request.
Keep successful proofs: Ethereum submission errors do not require new proofs.

Run local regressions with `cargo test --locked`. They use mock RPCs and never
request a paid proof or broadcast a transaction.
