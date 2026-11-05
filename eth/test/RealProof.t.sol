// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Test } from "forge-std/Test.sol";
import { BadBridge, IRouter } from "../src/BadBridge.sol";

/// Opt-in public-RPC test. Uses only a local fork: no signer or live transaction.
/// ETH_FORK_RPC=https://... forge test --match-contract RealProofForkTest
contract RealProofForkTest is Test {
    uint64 constant HEIGHT = 33092173;
    bytes32 constant ESCROW = 0xdc1f0f6f6ca471781a61908a2b4cbde33531539d1691c2d513157afde056182b;
    address constant RECIPIENT = 0xD2C392084761cb6E44c544B6f39dcc001fDe9775;
    BadBridge bridge;
    BadBridge.ConsensusState cs;
    BadBridge.SP1Proof proof;

    function setUp() public {
        string memory rpc = vm.envOr("ETH_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        // The client retains historical Hub roots; a current fork needs no archive node.
        vm.createSelectFork(rpc);
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/sp1_proof.json"));
        proof = BadBridge.SP1Proof({
            vKey: vm.parseJsonBytes32(json, ".vKey"),
            publicValues: vm.parseJsonBytes(json, ".publicValues"),
            proof: vm.parseJsonBytes(json, ".proof")
        });
        cs = BadBridge.ConsensusState({
            timestamp: 1790196616485314993,
            root: 0x70c6911e60a28bb6a913f45a123b5e925d2f9ee4db1c8d7c38cd61c6940cd648,
            nextValidatorsHash: 0xf62a108f4d782fc149e1c4dbf42002f4670da3e3202adccdefcbc050ee5f8921
        });
        bridge = new BadBridge(
            IRouter(0x3aF134307D5Ee90faa2ba9Cdba14ba66414CF1A7),
            "cosmoshub-0", ESCROW, "Bad Bridge Test", "BBT", "ipfs://test/",
            address(this), address(this), 0, ""
        );
    }

    function test_realProofMintsToRecordedRecipient() public {
        bridge.submitBatch(HEIGHT, cs, proof);
        bridge.claim(1);
        assertEq(bridge.ownerOf(1), RECIPIENT);
        assertEq(bridge.getVotes(RECIPIENT), 1);
        assertEq(bridge.totalSupply(), 1);
    }

    function test_changedRecipientIsRejected() public {
        BadBridge.MembershipOutput memory output = abi.decode(proof.publicValues, (BadBridge.MembershipOutput));
        output.kvPairs[0].value = abi.encodePacked(address(0xBAD));
        proof.publicValues = abi.encode(output);
        vm.expectRevert();
        bridge.submitBatch(HEIGHT, cs, proof);
        assertEq(bridge.proven(1), address(0));
        assertEq(bridge.totalSupply(), 0);
    }

    function test_damagedProofIsRejected() public {
        proof.proof[proof.proof.length - 1] ^= 0x01;
        vm.expectRevert();
        bridge.submitBatch(HEIGHT, cs, proof);
        assertEq(bridge.proven(1), address(0));
        assertEq(bridge.totalSupply(), 0);
    }
}
