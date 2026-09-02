// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Test } from "forge-std/Test.sol";
import { DreamDuelRoundEscrow } from "../src/DreamDuelRoundEscrow.sol";
import { IERC20 } from "../src/IERC20.sol";

contract MockTAUSDC2 is IERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address a, uint256 v) external { balanceOf[a] += v; }
    function approve(address s, uint256 v) external returns (bool) { allowance[msg.sender][s] = v; return true; }
    function transferFrom(address f, address t, uint256 v) external returns (bool) {
        uint256 al = allowance[f][msg.sender];
        if (al != type(uint256).max) { require(al >= v, "allow"); allowance[f][msg.sender] -= v; }
        require(balanceOf[f] >= v, "bal");
        balanceOf[f] -= v; balanceOf[t] += v; return true;
    }
    function transfer(address t, uint256 v) external returns (bool) {
        require(balanceOf[msg.sender] >= v, "bal");
        balanceOf[msg.sender] -= v; balanceOf[t] += v; return true;
    }
}

contract DreamDuelRoundEscrowTest is Test {
    MockTAUSDC2 token;
    DreamDuelRoundEscrow escrow;
    address admin = address(0xAAAA);
    address alice = address(0x1111);
    bytes32 matchId = keccak256("MATCH-0001");
    uint256 constant STAKE = 10e6;     // 10 tUSDC per round
    uint256 constant PRICE_HALF = 500_000; // 0.50 even
    uint256 constant PRICE_FAV = 824_000;  // 0.824 favorite

    function setUp() public {
        token = new MockTAUSDC2();
        escrow = new DreamDuelRoundEscrow(address(token), admin);
        token.mint(alice, 1000e6);
        vm.prank(alice); token.approve(address(escrow), type(uint256).max);
    }

    function _fundPool(uint256 amount) internal {
        vm.prank(admin); token.mint(admin, amount);
        vm.prank(admin); token.approve(address(escrow), type(uint256).max);
        vm.prank(admin); escrow.topUpProfitPool(amount);
    }

    function testStakeEachRoundSeparately() public {
        // Round 1 stake at 0.50, round 2 flips to a different price (side)
        vm.prank(alice); escrow.stakeRound(matchId, 1, STAKE, PRICE_HALF);
        vm.prank(alice); escrow.stakeRound(matchId, 2, STAKE, PRICE_FAV);
        DreamDuelRoundEscrow.RoundLock memory r1 = escrow.roundLock(matchId, 1);
        DreamDuelRoundEscrow.RoundLock memory r2 = escrow.roundLock(matchId, 2);
        assertEq(r1.amount, STAKE);
        assertEq(r1.entryPrice, PRICE_HALF);
        assertEq(r2.amount, STAKE);
        assertEq(r2.entryPrice, PRICE_FAV, "round 2 flipped side/price");
        assertEq(escrow.matchOwner(matchId), alice);
        // Both stakes held: 20 total for two rounds
        assertEq(token.balanceOf(address(escrow)), STAKE * 2);
        assertEq(escrow.withdrawable(matchId), 0, "no wins yet");
    }

    function testCannotDoubleStakeRound() public {
        vm.prank(alice); escrow.stakeRound(matchId, 1, STAKE, PRICE_HALF);
        vm.prank(alice); vm.expectRevert(DreamDuelRoundEscrow.RoundAlreadyStaked.selector);
        escrow.stakeRound(matchId, 1, STAKE, PRICE_HALF);
    }

    function testSamePerRoundStakeAcrossAllRounds() public {
        for (uint256 r = 1; r <= 7; r++) {
            vm.prank(alice); escrow.stakeRound(matchId, r, STAKE, PRICE_HALF);
        }
        // 7 rounds x 10 = 70 total, same 10-per-round
        assertEq(token.balanceOf(address(escrow)), STAKE * 7);
        assertEq(escrow.roundLock(matchId, 7).amount, STAKE);
    }

    function testSettleWonRoundCreditsDexPayout() public {
        vm.prank(alice); escrow.stakeRound(matchId, 1, STAKE, PRICE_HALF);
        _fundPool(20e6);
        vm.prank(admin); escrow.settleRound(matchId, 1, true);
        // 10 / 0.50 = 20 => credited to withdrawable
        assertEq(escrow.withdrawable(matchId), 20e6);
        uint256 before = token.balanceOf(alice);
        vm.prank(alice); escrow.withdraw(matchId);
        assertEq(token.balanceOf(alice), before + 20e6, "collected round-1 win");
        assertEq(escrow.withdrawable(matchId), 0);
    }

    function testMixedWinsAccumulateAcrossRounds() public {
        // stake all 7 rounds at 0.50; win 3, lose 4
        for (uint256 r = 1; r <= 7; r++) {
            vm.prank(alice); escrow.stakeRound(matchId, r, STAKE, PRICE_HALF);
        }
        _fundPool(100e6);
        uint256 winCount = 0;
        for (uint256 r = 1; r <= 7; r++) {
            bool won = r <= 3;
            vm.prank(admin); escrow.settleRound(matchId, r, won);
            if (won) winCount++;
        }
        // 3 wins x 20 = 60 withdrawable; 4 losses forfeited to house
        assertEq(escrow.withdrawable(matchId), 60e6);
        uint256 before = token.balanceOf(alice);
        vm.prank(alice); escrow.withdraw(matchId);
        assertEq(token.balanceOf(alice), before + 60e6);
        assertEq(escrow.withdrawable(matchId), 0);
    }

    function testLostRoundForfeitedToHouse() public {
        vm.prank(alice); escrow.stakeRound(matchId, 1, STAKE, PRICE_HALF);
        vm.prank(admin); escrow.settleRound(matchId, 1, false);
        assertEq(escrow.roundLock(matchId, 1).won, 2);
        assertEq(escrow.withdrawable(matchId), 0, "no win credited for loss");
        // owner cannot withdraw (nothing won)
        vm.prank(alice); vm.expectRevert(DreamDuelRoundEscrow.NothingToWithdraw.selector);
        escrow.withdraw(matchId);
        // admin collects the forfeited stake
        uint256 adminBefore = token.balanceOf(admin);
        vm.prank(admin); escrow.collectLost(matchId, 1);
        assertEq(token.balanceOf(admin), adminBefore + STAKE);
    }

    function testNonAdminCannotSettle() public {
        vm.prank(alice); escrow.stakeRound(matchId, 1, STAKE, PRICE_HALF);
        vm.prank(alice); vm.expectRevert(DreamDuelRoundEscrow.NotAdmin.selector);
        escrow.settleRound(matchId, 1, true);
    }

    function testStrangerCannotStakeSomeonesMatch() public {
        vm.prank(alice); escrow.stakeRound(matchId, 1, STAKE, PRICE_HALF);
        vm.prank(address(0x1234)); vm.expectRevert(DreamDuelRoundEscrow.NotOwner.selector);
        escrow.stakeRound(matchId, 2, STAKE, PRICE_HALF);
    }

    function testZeroAndBadEntryReverts() public {
        vm.prank(alice); vm.expectRevert(DreamDuelRoundEscrow.ZeroAmount.selector);
        escrow.stakeRound(matchId, 1, 0, PRICE_HALF);
        vm.prank(alice); vm.expectRevert(DreamDuelRoundEscrow.BadEntryPrice.selector);
        escrow.stakeRound(matchId, 1, STAKE, 0);
        vm.prank(alice); vm.expectRevert(DreamDuelRoundEscrow.BadRound.selector);
        escrow.stakeRound(matchId, 0, STAKE, PRICE_HALF);
    }

    function testWithdrawCappedByHoldings() public {
        // Win wants 20 but no profit pool; only the 10 stake held -> pays 10
        vm.prank(alice); escrow.stakeRound(matchId, 1, STAKE, PRICE_HALF);
        vm.prank(admin); escrow.settleRound(matchId, 1, true);
        uint256 before = token.balanceOf(alice);
        vm.prank(alice); escrow.withdraw(matchId);
        assertEq(token.balanceOf(alice), before + STAKE, "capped at holdings");
    }

    function testCannotDoubleSettleRound() public {
        vm.prank(alice); escrow.stakeRound(matchId, 1, STAKE, PRICE_HALF);
        vm.prank(admin); escrow.settleRound(matchId, 1, true);
        vm.prank(admin); vm.expectRevert(DreamDuelRoundEscrow.RoundAlreadySettled.selector);
        escrow.settleRound(matchId, 1, true);
    }
}
