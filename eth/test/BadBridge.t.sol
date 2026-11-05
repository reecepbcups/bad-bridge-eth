// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Test } from "forge-std/Test.sol";
import { BadBridge, IRouter, ISP1ICS07Tendermint, ISP1Verifier } from "../src/BadBridge.sol";

abstract contract BadBridgeBase is Test {
    address constant ROUTER = address(0x1001);
    address constant CLIENT = address(0x1002);
    address constant VERIFIER = address(0x1003);
    bytes32 constant ESCROW = bytes32(uint256(0xe5c0));
    bytes32 constant VKEY = bytes32(uint256(0x0bd8ec));
    uint64 constant HEIGHT = 100;

    BadBridge bridge;
    BadBridge.ConsensusState cs;

    function setUp() public virtual {
        vm.mockCall(ROUTER, abi.encodeCall(IRouter.getClient, ("cosmoshub-0")), abi.encode(CLIENT));
        bridge = new BadBridge(IRouter(ROUTER), "cosmoshub-0", ESCROW, "Bad Kids", "BADKIDS", "ipfs://x/", "ipfs://c");
        cs = BadBridge.ConsensusState({ timestamp: 1, root: keccak256("root"), nextValidatorsHash: bytes32(0) });

        vm.mockCall(CLIENT, abi.encodeCall(ISP1ICS07Tendermint.getConsensusStateHash, (HEIGHT)), abi.encode(keccak256(abi.encode(cs))));
        vm.mockCall(CLIENT, abi.encodeCall(ISP1ICS07Tendermint.MEMBERSHIP_PROGRAM_VKEY, ()), abi.encode(VKEY));
        vm.mockCall(CLIENT, abi.encodeCall(ISP1ICS07Tendermint.VERIFIER, ()), abi.encode(VERIFIER));
        vm.mockCall(VERIFIER, bytes(""), bytes(""));
        mockFrozen(false);
    }

    function mockFrozen(bool frozen) internal {
        vm.mockCall(
            CLIENT,
            abi.encodeCall(ISP1ICS07Tendermint.clientState, ()),
            abi.encode(
                "cosmoshub-4",
                ISP1ICS07Tendermint.TrustThreshold(1, 3),
                ISP1ICS07Tendermint.Height(4, HEIGHT),
                uint32(1),
                uint32(2),
                frozen,
                uint8(1)
            )
        );
    }

    function key(bytes32 escrow, bytes1 tag, uint32 tokenId) internal pure returns (bytes memory) {
        return abi.encodePacked(bytes1(0x03), escrow, tag, tokenId);
    }

    function kv(bytes memory k, bytes memory value) internal pure returns (BadBridge.KVPair memory p) {
        p.path = new bytes[](2);
        p.path[0] = "wasm";
        p.path[1] = k;
        p.value = value;
    }

    function proofFor(BadBridge.KVPair memory p) internal view returns (BadBridge.SP1Proof memory) {
        BadBridge.KVPair[] memory kvs = new BadBridge.KVPair[](1);
        kvs[0] = p;
        bytes memory pv = abi.encode(BadBridge.MembershipOutput({ commitmentRoot: cs.root, kvPairs: kvs }));
        return BadBridge.SP1Proof({ vKey: VKEY, publicValues: pv, proof: "" });
    }

    function proveAndClaim(uint32 tokenId, address to) internal {
        bridge.submitBatch(HEIGHT, cs, proofFor(kv(key(ESCROW, "b", tokenId), abi.encodePacked(to))));
        bridge.claim(tokenId);
    }
}

contract BadBridgeTest is BadBridgeBase {
    function test_submitAndClaim() public {
        address alice = makeAddr("alice");
        bridge.submitBatch(HEIGHT, cs, proofFor(kv(key(ESCROW, "b", 7012), abi.encodePacked(alice))));
        assertEq(bridge.proven(7012), alice);

        bridge.claim(7012);
        assertEq(bridge.ownerOf(7012), alice);
        assertEq(bridge.tokenURI(7012), "ipfs://x/7012");

        vm.expectRevert();
        bridge.claim(7012);
    }

    function test_claimToContractWithoutReceiver() public {
        // a multisig or plain contract must still receive the kid, _safeMint would revert here
        address vault = address(new NoReceiver());
        bridge.submitBatch(HEIGHT, cs, proofFor(kv(key(ESCROW, "b", 1), abi.encodePacked(vault))));
        bridge.claim(1);
        assertEq(bridge.ownerOf(1), vault);
    }

    function test_parseRejects() public {
        address alice = makeAddr("alice");
        bytes memory good = abi.encodePacked(alice);
        BadBridge.KVPair[6] memory bad = [
            kv(key(bytes32(uint256(0xbad)), "b", 1), good), // other contract
            kv(key(ESCROW, "c", 1), good), // other key namespace
            kv(abi.encodePacked(key(ESCROW, "b", 1), bytes1(0)), good), // trailing byte
            kv(abi.encodePacked(bytes1(0x04), ESCROW, bytes1("b"), uint32(1)), good), // other store prefix
            kv(key(ESCROW, "b", 1), abi.encodePacked(alice, bytes1(0))), // 21-byte value
            kv(key(ESCROW, "b", 1), good)
        ];
        bad[5].path[0] = "ibc"; // other store
        for (uint256 i = 0; i < bad.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(BadBridge.BadPath.selector, 0));
            bridge.submitBatch(HEIGHT, cs, proofFor(bad[i]));
        }
    }

    function test_rejectsWrongRootAndVKey() public {
        BadBridge.SP1Proof memory p = proofFor(kv(key(ESCROW, "b", 1), abi.encodePacked(address(1))));
        p.vKey = bytes32(uint256(1));
        vm.expectRevert(BadBridge.BadVKey.selector);
        bridge.submitBatch(HEIGHT, cs, p);

        BadBridge.ConsensusState memory other = cs;
        other.root = keccak256("other");
        vm.expectRevert(BadBridge.BadConsensusState.selector);
        bridge.submitBatch(HEIGHT, other, proofFor(kv(key(ESCROW, "b", 1), abi.encodePacked(address(1)))));
    }

    function test_rejectsFrozenClient() public {
        mockFrozen(true);
        vm.expectRevert(BadBridge.ClientFrozen.selector);
        bridge.submitBatch(HEIGHT, cs, proofFor(kv(key(ESCROW, "b", 1), abi.encodePacked(address(1)))));
    }

    function test_verifierReceivesExactProof() public {
        BadBridge.SP1Proof memory p = proofFor(kv(key(ESCROW, "b", 1), abi.encodePacked(address(1))));
        p.proof = hex"12345678";
        vm.expectCall(VERIFIER, abi.encodeCall(ISP1Verifier.verifyProof, (p.vKey, p.publicValues, p.proof)), 1);
        bridge.submitBatch(HEIGHT, cs, p);
        assertEq(bridge.proven(1), address(1));
    }

    function test_verifierRejectionCannotRecordOrMint() public {
        BadBridge.SP1Proof memory p = proofFor(kv(key(ESCROW, "b", 1), abi.encodePacked(address(1))));
        p.proof = hex"deadbeef";
        bytes memory callData = abi.encodeCall(ISP1Verifier.verifyProof, (p.vKey, p.publicValues, p.proof));
        bytes memory rejection = abi.encodeWithSignature("InvalidProof()");
        vm.mockCallRevert(VERIFIER, callData, rejection);
        vm.expectCall(VERIFIER, callData, 1);
        vm.expectRevert(rejection);
        bridge.submitBatch(HEIGHT, cs, p);
        assertEq(bridge.proven(1), address(0));
        assertEq(bridge.totalSupply(), 0);
        vm.expectRevert(abi.encodeWithSelector(BadBridge.NotProven.selector, 1));
        bridge.claim(1);
    }

    function testFuzz_parseOnlyAcceptsExactLayout(bytes calldata k, uint32 tokenId, address to) public view {
        BadBridge.KVPair memory p = kv(k, abi.encodePacked(to));
        try bridge.parse(p, 0) returns (uint32 id, address recipient) {
            assertEq(keccak256(k), keccak256(key(ESCROW, "b", id)));
            assertEq(recipient, to);
        } catch { }
        (uint32 id2,) = bridge.parse(kv(key(ESCROW, "b", tokenId), abi.encodePacked(to)), 0);
        assertEq(id2, tokenId);
    }

    function testFuzz_parseMutatedKey(uint32 tokenId, address to, uint8 pos, uint8 flip) public {
        vm.assume(flip != 0);
        bytes memory k = key(ESCROW, "b", tokenId);
        uint256 i = uint256(pos) % k.length;
        k[i] = k[i] ^ bytes1(flip);
        // only the 4 token id bytes may change, and then they decode as a different id
        if (i < 34) {
            vm.expectRevert(abi.encodeWithSelector(BadBridge.BadPath.selector, 0));
            bridge.parse(kv(k, abi.encodePacked(to)), 0);
        } else {
            (uint32 id,) = bridge.parse(kv(k, abi.encodePacked(to)), 0);
            assertTrue(id != tokenId);
        }
    }

    function testFuzz_parseRejectsKeyLength(uint32 tokenId, uint8 len) public {
        vm.assume(len != 38);
        bytes memory full = abi.encodePacked(key(ESCROW, "b", tokenId), new bytes(256));
        bytes memory k = new bytes(len);
        for (uint256 i = 0; i < len; ++i) {
            k[i] = full[i];
        }
        vm.expectRevert(abi.encodeWithSelector(BadBridge.BadPath.selector, 0));
        bridge.parse(kv(k, abi.encodePacked(address(1))), 0);
    }

    function testFuzz_parseRejectsValueLength(uint32 tokenId, bytes calldata value) public {
        vm.assume(value.length != 20);
        vm.expectRevert(abi.encodeWithSelector(BadBridge.BadPath.selector, 0));
        bridge.parse(kv(key(ESCROW, "b", tokenId), value), 0);
    }

    function testFuzz_parseRejectsStore(bytes calldata store, uint8 pathLen) public {
        BadBridge.KVPair memory p = kv(key(ESCROW, "b", 1), abi.encodePacked(address(1)));
        if (keccak256(store) != keccak256("wasm")) {
            p.path[0] = store;
            vm.expectRevert(abi.encodeWithSelector(BadBridge.BadPath.selector, 0));
            bridge.parse(p, 0);
        }
        pathLen = uint8(bound(pathLen, 0, 7));
        if (pathLen == 2) return;
        BadBridge.KVPair memory q;
        q.path = new bytes[](pathLen);
        for (uint256 i = 0; i < pathLen; ++i) {
            q.path[i] = i == 0 ? bytes("wasm") : key(ESCROW, "b", 1);
        }
        q.value = abi.encodePacked(address(1));
        vm.expectRevert(abi.encodeWithSelector(BadBridge.BadPath.selector, 0));
        bridge.parse(q, 0);
    }

    function testFuzz_firstRecordWins(uint32 tokenId, address first, address second) public {
        vm.assume(first != address(0) && second != address(0) && first != second);
        bridge.submitBatch(HEIGHT, cs, proofFor(kv(key(ESCROW, "b", tokenId), abi.encodePacked(first))));
        bridge.submitBatch(HEIGHT, cs, proofFor(kv(key(ESCROW, "b", tokenId), abi.encodePacked(second))));
        assertEq(bridge.proven(tokenId), first);

        bridge.claim(tokenId);
        assertEq(bridge.ownerOf(tokenId), first);
        vm.expectRevert();
        bridge.claim(tokenId);
    }

    function testFuzz_badPairRevertsWholeBatch(uint32 goodId, uint32 badId, uint8 badAt) public {
        BadBridge.KVPair[] memory kvs = new BadBridge.KVPair[](3);
        uint256 at = uint256(badAt) % kvs.length;
        for (uint256 i = 0; i < kvs.length; ++i) {
            kvs[i] = i == at
                ? kv(key(bytes32(uint256(0xbad)), "b", badId), abi.encodePacked(address(2)))
                : kv(key(ESCROW, "b", goodId), abi.encodePacked(address(1)));
        }
        bytes memory pv = abi.encode(BadBridge.MembershipOutput({ commitmentRoot: cs.root, kvPairs: kvs }));
        vm.expectRevert(abi.encodeWithSelector(BadBridge.BadPath.selector, at));
        bridge.submitBatch(HEIGHT, cs, BadBridge.SP1Proof({ vKey: VKEY, publicValues: pv, proof: "" }));
        assertEq(bridge.proven(goodId), address(0));
    }

    function testFuzz_unprovenCantClaim(uint32 tokenId) public {
        vm.expectRevert(abi.encodeWithSelector(BadBridge.NotProven.selector, tokenId));
        bridge.claim(tokenId);
    }

    function prove(uint32 tokenId, address to) internal {
        bridge.submitBatch(HEIGHT, cs, proofFor(kv(key(ESCROW, "b", tokenId), abi.encodePacked(to))));
    }

    function ids(uint32 a, uint32 b, uint32 c) internal pure returns (uint32[] memory out) {
        out = new uint32[](3);
        (out[0], out[1], out[2]) = (a, b, c);
    }

    function test_claimMany() public {
        address alice = makeAddr("alice");
        address bob = makeAddr("bob");
        prove(1, alice);
        prove(7012, bob);
        prove(9999, alice);
        bridge.claimMany(ids(1, 7012, 9999));
        assertEq(bridge.ownerOf(1), alice);
        assertEq(bridge.ownerOf(7012), bob);
        assertEq(bridge.ownerOf(9999), alice);
    }

    function test_claimManySkipsClaimed() public {
        address alice = makeAddr("alice");
        prove(1, alice);
        prove(2, alice);
        prove(3, alice);
        bridge.claim(2);
        bridge.claimMany(ids(1, 2, 3));
        assertEq(bridge.balanceOf(alice), 3);
        assertEq(bridge.totalSupply(), 3);
    }

    function test_claimManyDuplicateIds() public {
        address alice = makeAddr("alice");
        prove(5, alice);
        bridge.claimMany(ids(5, 5, 5));
        assertEq(bridge.balanceOf(alice), 1);
    }

    function test_claimManyUnprovenReverts() public {
        address alice = makeAddr("alice");
        prove(1, alice);
        prove(3, alice);
        vm.expectRevert(abi.encodeWithSelector(BadBridge.NotProven.selector, 2));
        bridge.claimMany(ids(1, 2, 3));
        assertEq(bridge.balanceOf(alice), 0);
    }

    function test_claimManyEmpty() public {
        bridge.claimMany(new uint32[](0));
        assertEq(bridge.totalSupply(), 0);
    }
}

contract BadBridgeVotesTest is BadBridgeBase {
    bytes32 constant DELEGATION_TYPEHASH = keccak256("Delegation(address delegatee,uint256 nonce,uint256 expiry)");
    bytes32 constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    function test_claimGivesVote() public {
        proveAndClaim(7012, alice);
        assertEq(bridge.getVotes(alice), 1);
        assertEq(bridge.delegates(alice), alice);
    }

    function test_transferMovesVote() public {
        proveAndClaim(1, alice);
        vm.prank(alice);
        bridge.transferFrom(alice, bob, 1);
        assertEq(bridge.getVotes(alice), 0);
        assertEq(bridge.getVotes(bob), 1);
    }

    function test_delegateAndBack() public {
        proveAndClaim(1, alice);
        proveAndClaim(2, alice);

        vm.prank(alice);
        bridge.delegate(carol);
        assertEq(bridge.delegates(alice), carol);
        assertEq(bridge.getVotes(alice), 0);
        assertEq(bridge.getVotes(carol), 2);

        // stock OZ would send these votes to address(0) and lose them
        vm.prank(alice);
        bridge.delegate(address(0));
        assertEq(bridge.delegates(alice), alice);
        assertEq(bridge.getVotes(alice), 2);
        assertEq(bridge.getVotes(carol), 0);
    }

    function testFuzz_delegateZeroNeverLosesVotes(uint8[8] calldata picks) public {
        address[4] memory targets = [alice, bob, carol, address(0)];
        proveAndClaim(1, alice);
        proveAndClaim(2, bob);
        proveAndClaim(3, bob);
        for (uint256 i = 0; i < picks.length; ++i) {
            // alternate who delegates so both holders move votes around
            address from = i % 2 == 0 ? alice : bob;
            vm.prank(from);
            bridge.delegate(targets[picks[i] % 4]);
            assertEq(bridge.getVotes(alice) + bridge.getVotes(bob) + bridge.getVotes(carol), bridge.totalSupply());
        }
    }

    function test_delegateBySig() public {
        (address signer, uint256 pk) = makeAddrAndKey("signer");
        proveAndClaim(1, signer);
        uint256 expiry = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = signDelegation(pk, carol, 0, expiry);

        bridge.delegateBySig(carol, 0, expiry, v, r, s);
        assertEq(bridge.delegates(signer), carol);
        assertEq(bridge.getVotes(carol), 1);

        vm.expectRevert(abi.encodeWithSignature("InvalidAccountNonce(address,uint256)", signer, 1));
        bridge.delegateBySig(carol, 0, expiry, v, r, s);

        (v, r, s) = signDelegation(pk, bob, 1, expiry);
        vm.warp(expiry + 1);
        vm.expectRevert(abi.encodeWithSignature("VotesExpiredSignature(uint256)", expiry));
        bridge.delegateBySig(bob, 1, expiry, v, r, s);
    }

    function test_pastVotesAndSupply() public {
        vm.warp(1000);
        proveAndClaim(1, alice);
        vm.warp(2000);
        proveAndClaim(2, alice);
        vm.warp(3000);

        assertEq(bridge.getPastTotalSupply(1500), 1);
        assertEq(bridge.getPastVotes(alice, 1500), 1);
        assertEq(bridge.getPastTotalSupply(2500), 2);
        assertEq(bridge.getPastVotes(alice, 2500), 2);

        // the current timepoint isn't final yet
        vm.expectRevert(abi.encodeWithSignature("ERC5805FutureLookup(uint256,uint48)", 3000, uint48(3000)));
        bridge.getPastTotalSupply(3000);
    }

    function test_clockMode() public {
        vm.warp(12_345);
        assertEq(bridge.clock(), 12_345);
        assertEq(bridge.CLOCK_MODE(), "mode=timestamp");
    }

    function test_totalSupplyTracksClaims() public {
        assertEq(bridge.totalSupply(), 0);
        proveAndClaim(1, alice);
        proveAndClaim(7012, bob);
        proveAndClaim(9999, carol);
        assertEq(bridge.totalSupply(), 3);
    }

    function test_contractRecipientGetsVotes() public {
        // escrow and lending contracts vote with the kids they hold, the cost of default self-delegation
        address vault = address(new NoReceiver());
        proveAndClaim(1, vault);
        assertEq(bridge.getVotes(vault), 1);
    }

    function signDelegation(uint256 pk, address delegatee, uint256 nonce, uint256 expiry)
        internal
        view
        returns (uint8, bytes32, bytes32)
    {
        bytes32 domain = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("Bad Kids"), keccak256("1"), block.chainid, address(bridge))
        );
        bytes32 structHash = keccak256(abi.encode(DELEGATION_TYPEHASH, delegatee, nonce, expiry));
        return vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
    }
}

contract BadBridgeMetadataTest is BadBridgeBase {
    function test_contractURI() public view {
        assertEq(bridge.contractURI(), "ipfs://c");
    }

    function test_supportsInterface() public view {
        assertTrue(bridge.supportsInterface(0x01ffc9a7)); // ERC-165
        assertTrue(bridge.supportsInterface(0x80ac58cd)); // ERC-721
        assertTrue(bridge.supportsInterface(0x5b5e139f)); // ERC-721 Metadata
        assertFalse(bridge.supportsInterface(0x2a55205a)); // ERC-2981, no royalty
        assertFalse(bridge.supportsInterface(0xffffffff));
    }
}

/// Drives random batches and claims so the invariants below run against many states.
contract Handler is Test {
    BadBridge public bridge;
    bytes32 root;
    bytes32 escrow;
    uint32[] public ids;
    mapping(uint32 => address) public firstSeen;
    mapping(uint32 => bool) public minted;

    constructor(BadBridge bridge_, bytes32 root_, bytes32 escrow_) {
        bridge = bridge_;
        root = root_;
        escrow = escrow_;
    }

    function submit(uint32 tokenId, address to) external {
        tokenId = uint32(bound(tokenId, 1, 50));
        if (to == address(0)) to = address(1);
        BadBridge.KVPair[] memory kvs = new BadBridge.KVPair[](1);
        kvs[0].path = new bytes[](2);
        kvs[0].path[0] = "wasm";
        kvs[0].path[1] = abi.encodePacked(bytes1(0x03), escrow, bytes1("b"), tokenId);
        kvs[0].value = abi.encodePacked(to);
        bytes memory pv = abi.encode(BadBridge.MembershipOutput({ commitmentRoot: root, kvPairs: kvs }));
        bridge.submitBatch(
            100,
            BadBridge.ConsensusState({ timestamp: 1, root: root, nextValidatorsHash: bytes32(0) }),
            BadBridge.SP1Proof({ vKey: bytes32(uint256(0x0bd8ec)), publicValues: pv, proof: "" })
        );
        if (firstSeen[tokenId] == address(0)) {
            firstSeen[tokenId] = to;
            ids.push(tokenId);
        }
    }

    function claim(uint256 seed) external {
        if (ids.length == 0) return;
        uint32 tokenId = ids[seed % ids.length];
        // a proven kid must always be claimable once, and only once
        if (minted[tokenId]) {
            vm.expectRevert();
            bridge.claim(tokenId);
        } else {
            bridge.claim(tokenId);
            minted[tokenId] = true;
        }
    }

    function claimMany(uint256 seed, uint8 n) external {
        if (ids.length == 0) return;
        uint32[] memory batch = new uint32[](bound(n, 0, 4));
        for (uint256 i = 0; i < batch.length; ++i) {
            batch[i] = ids[uint256(keccak256(abi.encode(seed, i))) % ids.length];
        }
        // proven ids only, so it must never revert, claimed or not
        bridge.claimMany(batch);
        for (uint256 i = 0; i < batch.length; ++i) {
            minted[batch[i]] = true;
        }
    }

    function idsLength() external view returns (uint256) {
        return ids.length;
    }
}

contract BadBridgeInvariantTest is BadBridgeBase {
    Handler handler;

    function setUp() public override {
        super.setUp();
        handler = new Handler(bridge, cs.root, ESCROW);
        targetContract(address(handler));
    }

    /// A recorded recipient never changes and a minted kid always sits with it (nobody transfers in this run).
    function invariant_recordsStickAndMintsMatch() public view {
        for (uint256 i = 0; i < handler.idsLength(); ++i) {
            uint32 id = handler.ids(i);
            assertEq(bridge.proven(id), handler.firstSeen(id));
            if (handler.minted(id)) assertEq(bridge.ownerOf(id), handler.firstSeen(id));
        }
    }
}

/// Like Handler, but kids move and votes get delegated. Everyone involved is in a fixed actor set
/// so the invariants can add up every vote.
contract VotesHandler is Test {
    BadBridge public bridge;
    bytes32 root;
    bytes32 escrow;
    address[5] public actors;
    uint32[] public minted;
    mapping(uint32 => bool) public isMinted;
    mapping(uint32 => bool) seen;
    uint32[] proven;

    constructor(BadBridge bridge_, bytes32 root_, bytes32 escrow_) {
        bridge = bridge_;
        root = root_;
        escrow = escrow_;
        for (uint256 i = 0; i < actors.length; ++i) {
            actors[i] = makeAddr(string.concat("actor", vm.toString(i)));
        }
    }

    function submit(uint32 tokenId, uint8 toIdx) external {
        tokenId = uint32(bound(tokenId, 1, 50));
        BadBridge.KVPair[] memory kvs = new BadBridge.KVPair[](1);
        kvs[0].path = new bytes[](2);
        kvs[0].path[0] = "wasm";
        kvs[0].path[1] = abi.encodePacked(bytes1(0x03), escrow, bytes1("b"), tokenId);
        kvs[0].value = abi.encodePacked(actors[toIdx % actors.length]);
        bytes memory pv = abi.encode(BadBridge.MembershipOutput({ commitmentRoot: root, kvPairs: kvs }));
        bridge.submitBatch(
            100,
            BadBridge.ConsensusState({ timestamp: 1, root: root, nextValidatorsHash: bytes32(0) }),
            BadBridge.SP1Proof({ vKey: bytes32(uint256(0x0bd8ec)), publicValues: pv, proof: "" })
        );
        if (!seen[tokenId]) {
            seen[tokenId] = true;
            proven.push(tokenId);
        }
    }

    function claim(uint256 seed) external {
        if (proven.length == 0) return;
        uint32 tokenId = proven[seed % proven.length];
        if (isMinted[tokenId]) return;
        bridge.claim(tokenId);
        isMinted[tokenId] = true;
        minted.push(tokenId);
    }

    function claimMany(uint256 seed, uint8 n) external {
        if (proven.length == 0) return;
        uint32[] memory batch = new uint32[](bound(n, 0, 4));
        for (uint256 i = 0; i < batch.length; ++i) {
            batch[i] = proven[uint256(keccak256(abi.encode(seed, i))) % proven.length];
        }
        bridge.claimMany(batch);
        for (uint256 i = 0; i < batch.length; ++i) {
            if (!isMinted[batch[i]]) {
                isMinted[batch[i]] = true;
                minted.push(batch[i]);
            }
        }
    }

    function transfer(uint256 seed, uint8 toIdx) external {
        if (minted.length == 0) return;
        uint32 tokenId = minted[seed % minted.length];
        address from = bridge.ownerOf(tokenId);
        vm.prank(from);
        bridge.transferFrom(from, actors[toIdx % actors.length], tokenId);
    }

    function delegate(uint8 fromIdx, uint8 toIdx) external {
        // one extra slot picks address(0), which must mean "back to self"
        uint256 t = toIdx % (actors.length + 1);
        vm.prank(actors[fromIdx % actors.length]);
        bridge.delegate(t == actors.length ? address(0) : actors[t]);
    }

    function warp(uint32 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 1 days));
    }

    function mintedLength() external view returns (uint256) {
        return minted.length;
    }
}

contract BadBridgeVotesInvariantTest is BadBridgeBase {
    VotesHandler handler;

    function setUp() public override {
        super.setUp();
        handler = new VotesHandler(bridge, cs.root, ESCROW);
        targetContract(address(handler));
    }

    function invariant_votesSumToSupply() public view {
        uint256 sum;
        for (uint256 i = 0; i < 5; ++i) {
            sum += bridge.getVotes(handler.actors(i));
        }
        assertEq(sum, bridge.totalSupply());
    }

    /// Every actor's votes are exactly the kids held by whoever delegates to them.
    function invariant_votesMatchDelegations() public view {
        for (uint256 i = 0; i < 5; ++i) {
            address a = handler.actors(i);
            uint256 expected;
            for (uint256 j = 0; j < 5; ++j) {
                address h = handler.actors(j);
                if (bridge.delegates(h) == a) expected += bridge.balanceOf(h);
            }
            assertEq(bridge.getVotes(a), expected);
        }
    }

    function invariant_supplyMatchesMints() public view {
        assertEq(bridge.totalSupply(), handler.mintedLength());
    }
}

contract NoReceiver { }
