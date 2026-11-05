// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Test } from "forge-std/Test.sol";
import { BadBridge, IRouter } from "../src/BadBridge.sol";
import { BadBridgeBase } from "./BadBridge.t.sol";

/// Who can call what. Every state changing entry point is either open to anyone and fully
/// determined by its inputs, or gated to one role.
contract BadBridgeAccessTest is BadBridgeBase {
    /// No owner or admin. The old owner and royalty entry points are gone, and contractURI is fixed at deploy.
    function testFuzz_noPrivilegedCalls(address eve, string calldata uri) public {
        bytes[7] memory calls = [
            abi.encodeWithSignature("owner()"),
            abi.encodeWithSignature("pendingOwner()"),
            abi.encodeWithSignature("transferOwnership(address)", eve),
            abi.encodeWithSignature("renounceOwnership()"),
            abi.encodeWithSignature("acceptOwnership()"),
            abi.encodeWithSignature("setContractURI(string)", uri),
            abi.encodeWithSignature("setRoyalty(address,uint96)", eve, uint96(500))
        ];
        vm.startPrank(eve);
        for (uint256 i = 0; i < calls.length; ++i) {
            (bool ok,) = address(bridge).call(calls[i]);
            assertFalse(ok);
        }
        vm.stopPrank();
        assertEq(bridge.contractURI(), "ipfs://c");
    }

    /// submitBatch and claim are open, but msg.sender never ends up in state. The proof decides everything.
    function testFuzz_callerNeverMatters(address caller, uint32 tokenId, address to) public {
        vm.assume(to != address(0) && caller != address(0) && caller != to);
        vm.startPrank(caller);
        bridge.submitBatch(HEIGHT, cs, proofFor(kv(key(ESCROW, "b", tokenId), abi.encodePacked(to))));
        bridge.claim(tokenId);
        vm.stopPrank();

        assertEq(bridge.proven(tokenId), to);
        assertEq(bridge.ownerOf(tokenId), to);
        assertEq(bridge.balanceOf(caller), 0);
        assertEq(bridge.getVotes(caller), 0);
    }

    /// Same for claimMany, with a mix of fresh and already claimed ids.
    function testFuzz_claimManyMintsToRecipients(address caller, uint32 a, uint32 b, address toA, address toB) public {
        vm.assume(a != b && toA != address(0) && toB != address(0) && caller != address(0));
        vm.assume(caller != toA && caller != toB);
        bridge.submitBatch(HEIGHT, cs, proofFor(kv(key(ESCROW, "b", a), abi.encodePacked(toA))));
        bridge.submitBatch(HEIGHT, cs, proofFor(kv(key(ESCROW, "b", b), abi.encodePacked(toB))));
        bridge.claim(a);

        uint32[] memory ids = new uint32[](3);
        (ids[0], ids[1], ids[2]) = (a, b, a);
        vm.prank(caller);
        bridge.claimMany(ids);

        assertEq(bridge.ownerOf(a), toA);
        assertEq(bridge.ownerOf(b), toB);
        assertEq(bridge.balanceOf(caller), 0);
    }

    /// A claimed kid only moves when its holder, or someone the holder approved, says so. Not the deployer, not the prover.
    function testFuzz_onlyHolderMovesKid(address eve, uint32 tokenId) public {
        address alice = makeAddr("alice");
        vm.assume(eve != alice && eve != address(0));
        proveAndClaim(tokenId, alice);

        address[2] memory outsiders = [eve, address(this)];
        for (uint256 i = 0; i < outsiders.length; ++i) {
            if (outsiders[i] == alice) continue;
            vm.prank(outsiders[i]);
            vm.expectRevert(
                abi.encodeWithSignature("ERC721InsufficientApproval(address,uint256)", outsiders[i], uint256(tokenId))
            );
            bridge.transferFrom(alice, outsiders[i], tokenId);
        }
        assertEq(bridge.ownerOf(tokenId), alice);
    }

    /// Eureka's router admin can point "cosmoshub-0" at a new client. The bridge keeps the one it deployed with.
    function testFuzz_routerSwapIgnored(address evil, uint32 tokenId) public {
        vm.assume(evil != CLIENT);
        vm.mockCall(ROUTER, abi.encodeCall(IRouter.getClient, ("cosmoshub-0")), abi.encode(evil));
        assertEq(address(bridge.lightClient()), CLIENT);
        // the evil client would have accepted anything, the pinned one still checks the root
        BadBridge.ConsensusState memory fake = cs;
        fake.root = keccak256("fake");
        vm.expectRevert(BadBridge.BadConsensusState.selector);
        bridge.submitBatch(HEIGHT, fake, proofFor(kv(key(ESCROW, "b", tokenId), abi.encodePacked(address(1)))));
    }

    /// A proof for the wrong escrow, store or namespace never records anything, whoever submits it.
    function testFuzz_foreignEscrowRejected(address caller, bytes32 escrow, uint32 tokenId) public {
        vm.assume(escrow != ESCROW);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(BadBridge.BadPath.selector, 0));
        bridge.submitBatch(HEIGHT, cs, proofFor(kv(key(escrow, "b", tokenId), abi.encodePacked(address(1)))));
        assertEq(bridge.proven(tokenId), address(0));
    }
}

/// Random actors hammer every entry point. None of them has a role, so nothing they do can rewrite a record.
contract AccessHandler is Test {
    BadBridge public bridge;
    bytes32 root;
    bytes32 escrow;
    address[4] public actors;

    // model
    mapping(uint32 => address) public firstSeen;
    uint32[] public ids;

    constructor(BadBridge bridge_, bytes32 root_, bytes32 escrow_, address deployer) {
        bridge = bridge_;
        root = root_;
        escrow = escrow_;
        actors = [deployer, makeAddr("eve"), makeAddr("dao"), makeAddr("mallory")];
    }

    function actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function submit(uint256 who, uint32 tokenId, uint256 to) external {
        tokenId = uint32(bound(tokenId, 1, 20));
        address recipient = actor(to);
        BadBridge.KVPair[] memory kvs = new BadBridge.KVPair[](1);
        kvs[0].path = new bytes[](2);
        kvs[0].path[0] = "wasm";
        kvs[0].path[1] = abi.encodePacked(bytes1(0x03), escrow, bytes1("b"), tokenId);
        kvs[0].value = abi.encodePacked(recipient);
        bytes memory pv = abi.encode(BadBridge.MembershipOutput({ commitmentRoot: root, kvPairs: kvs }));
        vm.prank(actor(who));
        bridge.submitBatch(
            100,
            BadBridge.ConsensusState({ timestamp: 1, root: root, nextValidatorsHash: bytes32(0) }),
            BadBridge.SP1Proof({ vKey: bytes32(uint256(0x0bd8ec)), publicValues: pv, proof: "" })
        );
        if (firstSeen[tokenId] == address(0)) {
            firstSeen[tokenId] = recipient;
            ids.push(tokenId);
        }
    }

    function claim(uint256 who, uint256 seed) external {
        if (ids.length == 0) return;
        uint32 tokenId = ids[seed % ids.length];
        uint32[] memory one = new uint32[](1);
        one[0] = tokenId;
        // claimMany never reverts for proven ids, so it works whether or not it's claimed yet
        vm.prank(actor(who));
        bridge.claimMany(one);
    }

    function idsLength() external view returns (uint256) {
        return ids.length;
    }
}

contract BadBridgeAccessInvariantTest is BadBridgeBase {
    AccessHandler handler;

    function setUp() public override {
        super.setUp();
        handler = new AccessHandler(bridge, cs.root, ESCROW, address(this));
        targetContract(address(handler));
    }

    function invariant_contractURIFixed() public view {
        assertEq(bridge.contractURI(), "ipfs://c");
    }

    /// Whatever anyone did, records stick and minted kids sit with their recipient (nobody transfers here).
    function invariant_nobodyTouchesKids() public view {
        for (uint256 i = 0; i < handler.idsLength(); ++i) {
            uint32 id = handler.ids(i);
            address want = handler.firstSeen(id);
            assertEq(bridge.proven(id), want);
            try bridge.ownerOf(id) returns (address got) {
                assertEq(got, want);
            } catch { }
        }
    }
}
