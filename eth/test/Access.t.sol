// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Test } from "forge-std/Test.sol";
import { BadBridge, IRouter } from "../src/BadBridge.sol";
import { BadBridgeBase } from "./BadBridge.t.sol";

/// Who can call what. Every state changing entry point is either open to anyone and fully
/// determined by its inputs, or gated to one role.
contract BadBridgeAccessTest is BadBridgeBase {
    function testFuzz_nonOwnerLocksOut(address eve, address receiver, uint96 bps, string calldata uri) public {
        // msg.sender is never zero on chain, and zero would match the empty pendingOwner
        vm.assume(eve != OWNER && eve != address(0));
        bytes memory unauthorized = abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", eve);
        vm.startPrank(eve);
        vm.expectRevert(unauthorized);
        bridge.setRoyalty(receiver, bps);
        vm.expectRevert(unauthorized);
        bridge.setContractURI(uri);
        vm.expectRevert(unauthorized);
        bridge.transferOwnership(eve);
        vm.expectRevert(unauthorized);
        bridge.renounceOwnership();
        // nobody is pending yet, so accepting is also out
        vm.expectRevert(unauthorized);
        bridge.acceptOwnership();
        vm.stopPrank();
        assertEq(bridge.owner(), OWNER);
    }

    /// Only the exact pending owner can finish a handover, and the old owner keeps control until then.
    function testFuzz_onlyPendingOwnerAccepts(address next, address eve) public {
        vm.assume(next != address(0) && eve != next && eve != OWNER);
        vm.prank(OWNER);
        bridge.transferOwnership(next);

        vm.prank(eve);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", eve));
        bridge.acceptOwnership();
        assertEq(bridge.owner(), OWNER);

        vm.prank(next);
        bridge.acceptOwnership();
        assertEq(bridge.owner(), next);
        assertEq(bridge.pendingOwner(), address(0));
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

    /// A claimed kid only moves when its holder, or someone the holder approved, says so. Not the owner, not the prover.
    function testFuzz_onlyHolderMovesKid(address eve, uint32 tokenId) public {
        address alice = makeAddr("alice");
        vm.assume(eve != alice && eve != address(0));
        proveAndClaim(tokenId, alice);

        address[2] memory outsiders = [eve, OWNER];
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

/// Random actors hammer every entry point. A reference model of the roles says what must succeed,
/// so a call landing where the model says it can't (or failing where it should work) breaks the run.
contract AccessHandler is Test {
    BadBridge public bridge;
    bytes32 root;
    bytes32 escrow;
    address[4] public actors;

    // model
    address public owner;
    address public pending;
    mapping(uint32 => address) public firstSeen;
    uint32[] public ids;

    constructor(BadBridge bridge_, bytes32 root_, bytes32 escrow_, address owner_) {
        bridge = bridge_;
        root = root_;
        escrow = escrow_;
        owner = owner_;
        actors = [owner_, makeAddr("eve"), makeAddr("dao"), makeAddr("mallory")];
    }

    function actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function setRoyalty(uint256 who, uint96 bps) external {
        address a = actor(who);
        bps = uint96(bound(bps, 0, 1000));
        vm.prank(a);
        try bridge.setRoyalty(a, bps) {
            assertEq(a, owner, "non owner set royalty");
        } catch {
            assertTrue(a != owner, "owner could not set royalty");
        }
    }

    function setContractURI(uint256 who, string calldata uri) external {
        address a = actor(who);
        vm.prank(a);
        try bridge.setContractURI(uri) {
            assertEq(a, owner, "non owner set contractURI");
        } catch {
            assertTrue(a != owner, "owner could not set contractURI");
        }
    }

    function transferOwnership(uint256 who, uint256 to) external {
        address a = actor(who);
        address next = actor(to);
        vm.prank(a);
        try bridge.transferOwnership(next) {
            assertEq(a, owner, "non owner started a handover");
            pending = next;
        } catch {
            assertTrue(a != owner, "owner could not start a handover");
        }
    }

    function acceptOwnership(uint256 who) external {
        address a = actor(who);
        vm.prank(a);
        try bridge.acceptOwnership() {
            assertEq(a, pending, "non pending owner took over");
            owner = a;
            pending = address(0);
        } catch {
            assertTrue(a != pending, "pending owner could not accept");
        }
    }

    function renounceOwnership(uint256 who) external {
        address a = actor(who);
        vm.prank(a);
        try bridge.renounceOwnership() {
            assertEq(a, owner, "non owner renounced");
            owner = address(0);
            pending = address(0);
        } catch {
            assertTrue(a != owner, "owner could not renounce");
        }
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
        handler = new AccessHandler(bridge, cs.root, ESCROW, OWNER);
        targetContract(address(handler));
    }

    function invariant_rolesMatchModel() public view {
        assertEq(bridge.owner(), handler.owner());
        assertEq(bridge.pendingOwner(), handler.pending());
    }

    function invariant_royaltyCapped() public view {
        (, uint256 amount) = bridge.royaltyInfo(1, 10_000);
        assertLe(amount, bridge.MAX_ROYALTY_BPS());
    }

    /// Whatever the owner did, records stick and minted kids sit with their recipient (nobody transfers here).
    function invariant_ownerNeverTouchesKids() public view {
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
