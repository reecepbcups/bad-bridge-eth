# Escrow release build

From the repository root:

```bash
cargo install cosmwasm-check --version 2.3.4 --locked
scripts/build-escrow.sh
(cd escrow/artifacts && shasum -a 256 -c checksums.txt)
(cd escrow && shasum -a 256 -c artifacts/source.sha256)
```

Docker must be running. The script stages `Cargo.toml`, `Cargo.lock`, and `src/`, checks that the optimizer did not change the lockfile, and only replaces the release artifacts after the VM compatibility check succeeds. `source.sha256` binds the checked-in Wasm to its input files; rebuild whenever any of them changes. Repeat builds from the same input files must produce the same Wasm checksum before deployment. The contract's current source has one Rust file, `src/lib.rs`; add any new source files to this manifest if the crate grows.

The compiler image is `cosmwasm/optimizer:0.17.0`, pinned to digest `sha256:7e0b9229c1a4118d0c9a2af2e7f5d95a91f264c26a2ce5681c779926e74d7f85`, using `linux/amd64` even on Apple Silicon. It contains Rust 1.86.0 and Binaryen 116. The older 0.16.1 image cannot parse the locked `zeroize` dependency's Rust 2024 edition.

The Hub reported `wasmvm/v2 v2.3.5` on 2026-11-05. Optimizer 0.17.0 normally targets CosmWasm 3+, because it removed sign-extension lowering. The script restores `wasm-opt --signext-lowering`, then validates the result with `cosmwasm-check 2.3.4`. Do not omit that pass or substitute an ARM optimizer image. See the upstream [optimizer changelog](https://github.com/CosmWasm/optimizer/blob/main/CHANGELOG.md) and [reproducibility guidance](https://github.com/CosmWasm/optimizer).

The checker validates the Wasm format, imports, exports, capabilities, and VM compatibility using its default limits. Recheck the target chain's limits and code-upload permissions before uploading. The source tests remain separate:

```bash
cd escrow
cargo test --locked
```

After upload, compare the code's on-chain checksum to `artifacts/checksums.txt`. Instantiate with `--no-admin`, verify the selected collection, and renounce the separate internal EmergencyUnlock admin before opening public deposits; see `../mainnet.md`.
