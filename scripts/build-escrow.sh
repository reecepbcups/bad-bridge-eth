#!/usr/bin/env bash
# Rebuild the deployable escrow from locked source, with CosmWasm 2 compatibility.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
escrow="$repo/escrow"
image=cosmwasm/optimizer:0.17.0@sha256:7e0b9229c1a4118d0c9a2af2e7f5d95a91f264c26a2ce5681c779926e74d7f85

if ! command -v cosmwasm-check >/dev/null || [[ "$(cosmwasm-check --version)" != 'Contract checking 2.3.4' ]]; then
  echo 'Install the pinned checker first: cargo install cosmwasm-check --version 2.3.4 --locked' >&2
  exit 1
fi

# Failed builds must leave the previously verified artifact untouched.
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp "$escrow/Cargo.toml" "$escrow/Cargo.lock" "$stage/"
cp -R "$escrow/src" "$stage/src"

docker run --rm --platform linux/amd64 \
  --mount "type=bind,source=$stage,target=/code" \
  --mount type=volume,source=bad_bridge_escrow_optimizer_cache_017,target=/target \
  --mount type=volume,source=bad_bridge_escrow_registry_cache,target=/usr/local/cargo/registry \
  --entrypoint /bin/sh "$image" -ec '
    cp Cargo.lock /tmp/input-Cargo.lock
    optimize.sh .
    cmp Cargo.lock /tmp/input-Cargo.lock
    # Optimizer 0.17 removed this pass; the Hub still uses CosmWasm 2.
    wasm-opt artifacts/bad_bridge_escrow.wasm --signext-lowering -o artifacts/bad_bridge_escrow.wasm
    sha256sum Cargo.toml Cargo.lock src/lib.rs > artifacts/source.sha256
    cd artifacts
    sha256sum bad_bridge_escrow.wasm > checksums.txt
  '

cosmwasm-check "$stage/artifacts/bad_bridge_escrow.wasm"
mkdir -p "$escrow/artifacts"
cp "$stage/artifacts/bad_bridge_escrow.wasm" "$stage/artifacts/checksums.txt" "$stage/artifacts/source.sha256" "$escrow/artifacts/"
cat "$escrow/artifacts/checksums.txt"
