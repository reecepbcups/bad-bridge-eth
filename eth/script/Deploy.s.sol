// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Script, console } from "forge-std/Script.sol";
import { BadBridge, IRouter } from "../src/BadBridge.sol";
import { Base64 } from "@openzeppelin/contracts/utils/Base64.sol";

/// Production deploy. There's no owner, so CONTRACT_URI is final once this runs.
/// env: ESCROW (raw 32-byte Hub escrow address)
contract Deploy is Script {
    IRouter constant ROUTER = IRouter(0x3aF134307D5Ee90faa2ba9Cdba14ba66414CF1A7);

    function run() external {
        bytes32 escrow = vm.envBytes32("ESCROW");
        require(escrow != bytes32(0), "ESCROW unset");
        string memory contractURI = vm.envOr(
            "CONTRACT_URI",
            string.concat(
                "data:application/json;base64,",
                Base64.encode(
                    '{"name":"Bad Kids","description":"Bad Kids is a collection of 9,999 bad drawings of bad kids","image":"ipfs://QmSFc8TPuVwLUfxEov7s66rfKoJ75NRcBRC4uQjMRcJoZ9/badkids.jpg","external_link":"https://badkids.com/"}'
                )
            )
        );

        vm.startBroadcast();
        BadBridge bridge = new BadBridge(
            ROUTER,
            "cosmoshub-0",
            escrow,
            vm.envOr("NAME", string("Bad Kids")),
            vm.envOr("SYMBOL", string("BADKIDS")),
            vm.envOr("BASE_URI", string("ipfs://QmUoHk4hY6mNoHgNEJDcy94APUky6o8xVmyD3YzddJtUWe/")),
            contractURI
        );
        vm.stopBroadcast();

        console.log("bridge", address(bridge));
        console.log("light client", address(bridge.lightClient()));
        console.log("contractURI", bridge.contractURI());
    }
}
