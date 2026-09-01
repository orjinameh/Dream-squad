// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";
import { DreamDuelEscrow } from "../src/DreamDuelEscrow.sol";

contract DeployScript is Script {
    function run() public {
        address tUSDC = 0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E;
        // OPERATOR_ADDRESS — the relayer that resolves windows from the real EC
        // settlement and the counterparty that funds winning positions via the
        // house reserve (topUpHouse).
        address admin = 0xdd68998C099f7570E59019ae35469E5603cEDA11;
        uint256 windowLength = 900; // 15-minute EC window

        vm.startBroadcast();
        DreamDuelEscrow escrow = new DreamDuelEscrow(tUSDC, admin, windowLength);
        vm.stopBroadcast();

        console2.log("DreamDuelEscrow v2 deployed at:", address(escrow));
        console2.log("windowLength:", escrow.windowLength());
    }
}
