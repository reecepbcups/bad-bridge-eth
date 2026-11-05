#!/usr/bin/env bash
# Instantiate the escrow contract for an explicitly chosen collection and temporary EmergencyUnlock admin.
# No CosmWasm admin (--no-admin): production escrow deployments stay non-migratable.
#
# Required env: CW721, ADMIN, FROM_KEY. Optional: NODE.
# Renounce the internal ADMIN before opening the bridge to public deposits.

set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: $0 <code-id> [label]" >&2
  exit 1
fi

code_id="$1"
label="${2:-bad-bridge-escrow}"
[[ "$code_id" =~ ^[1-9][0-9]*$ ]] || { echo 'code-id must be a positive integer' >&2; exit 1; }

: "${CW721:?Set CW721 to the collection contract you intend to bridge}"
: "${ADMIN:?Set ADMIN to the temporary emergency-unlock administrator}"
: "${FROM_KEY:?Set FROM_KEY to the local gaiad key name}"
NODE="${NODE:-https://cosmos-rpc.polkachu.com:443}"

# Restrict the JSON fields to Hub addresses, then have gaiad check their checksums locally.
for address in "$CW721" "$ADMIN"; do
  [[ "$address" =~ ^cosmos1[023456789acdefghjklmnpqrstuvwxyz]+$ ]] || { echo 'CW721 and ADMIN must be Cosmos Hub addresses' >&2; exit 1; }
  gaiad debug addr "$address" >/dev/null
done

echo "Collection: $CW721; temporary admin: $ADMIN; signer: $FROM_KEY; code: $code_id" >&2

gaiad tx wasm instantiate "$code_id" \
  '{"cw721":"'"$CW721"'","admin":"'"$ADMIN"'"}' \
  --label "$label" --no-admin \
  --from "$FROM_KEY" --chain-id cosmoshub-4 --gas auto --gas-adjustment 1.3 --gas-prices 0.005uatom \
  --node "$NODE" -y
