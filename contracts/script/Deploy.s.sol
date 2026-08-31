// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";
import { DreamDuelEscrow } from "../src/DreamDuelEscrow.sol";

contract DeployScript is Script {
    function run() public {
        address tUSDC = 0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E;
        address admin = 0xdd68998C099f7570E59019ae35469E5603cEDA11;
        uint256 refundDelay = 900;

        // Optional distinct house/treasury that receives forfeited solo (bot)
        // stakes. Leave as the admin wallet if you want solo losses kept in the
        // same operator wallet.
        address house = admin;

        vm.startBroadcast();
        DreamDuelEscrow escrow = new DreamDuelEscrow(tUSDC, admin, refundDelay);
        if (house != admin) {
            escrow.setHouse(house);
        }
        vm.stopBroadcast();

        console2.log("DreamDuelEscrow deployed at:", address(escrow));
        console2.log("house:", escrow.house());
    }
}
