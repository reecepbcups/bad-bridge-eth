// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Script, console } from "forge-std/Script.sol";
import { BadBridge, IRouter } from "../src/BadBridge.sol";

/// Deploys BadBridge (or reuses BRIDGE), submits the batcher's SP1 proof, claims TOKEN_ID.
/// env: PROOF_JSON, HEIGHT, CS_TIMESTAMP, CS_ROOT, CS_NVH, ESCROW, TOKEN_ID, optional BRIDGE
contract E2E is Script {
    IRouter constant ROUTER = IRouter(0x3aF134307D5Ee90faa2ba9Cdba14ba66414CF1A7);

    function run() external {
        string memory json = vm.readFile(vm.envString("PROOF_JSON"));
        BadBridge.SP1Proof memory proof = BadBridge.SP1Proof({
            vKey: vm.parseJsonBytes32(json, ".vKey"),
            publicValues: vm.parseJsonBytes(json, ".publicValues"),
            proof: vm.parseJsonBytes(json, ".proof")
        });
        BadBridge.ConsensusState memory cs = BadBridge.ConsensusState({
            timestamp: uint128(vm.envUint("CS_TIMESTAMP")),
            root: vm.envBytes32("CS_ROOT"),
            nextValidatorsHash: vm.envBytes32("CS_NVH")
        });
        uint32 tokenId = uint32(vm.envUint("TOKEN_ID"));

        vm.startBroadcast();
        BadBridge bridge = BadBridge(vm.envOr("BRIDGE", address(0)));
        if (address(bridge) == address(0)) {
            // test deploy, no contractURI
            bridge = new BadBridge(
                ROUTER,
                "cosmoshub-0",
                vm.envBytes32("ESCROW"),
                vm.envOr("NAME", string("Bad Bridge Test")),
                vm.envOr("SYMBOL", string("BBT")),
                vm.envOr("BASE_URI", string("ipfs://bad-bridge-test/")),
                ""
            );
        }
        bridge.submitBatch(uint64(vm.envUint("HEIGHT")), cs, proof);
        bridge.claim(tokenId);
        vm.stopBroadcast();

        console.log("bridge", address(bridge));
        address holder = bridge.ownerOf(tokenId);
        console.log("owner of token", holder);
        // a reused BRIDGE may predate votes (ReeceBadTest does), so don't let the logging revert the run
        try bridge.getVotes(holder) returns (uint256 votes) {
            console.log("holder votes", votes);
            console.log("total supply", bridge.totalSupply());
        } catch {
            console.log("bridge has no votes");
        }
    }
}
