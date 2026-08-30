// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Test } from "forge-std/Test.sol";
import { DreamDuelEscrow } from "../src/DreamDuelEscrow.sol";
import { IERC20 } from "../src/IERC20.sol";

contract MockTAUSDC is IERC20 {
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

contract DreamDuelEscrowTest is Test {
    MockTAUSDC token;
    DreamDuelEscrow escrow;
    address admin = address(0xAAAA);
    address alice = address(0x1111);
    address bob = address(0x2222);
    bytes32 matchId = keccak256("match-1");

    function setUp() public {
        token = new MockTAUSDC();
        escrow = new DreamDuelEscrow(address(token), admin, 300);
        token.mint(alice, 1000e6);
        token.mint(bob, 1000e6);
        vm.prank(alice); token.approve(address(escrow), type(uint256).max);
        vm.prank(bob); token.approve(address(escrow), type(uint256).max);
    }

    function testFullSettlePaysWinnerPot() public {
        vm.prank(admin); escrow.openMatch(matchId, alice, bob);
        vm.prank(alice); escrow.stake(matchId, 100e6);
        vm.prank(bob); escrow.stake(matchId, 100e6);
        uint256 before = token.balanceOf(alice);
        vm.prank(admin); escrow.settle(matchId, alice);
        assertEq(token.balanceOf(alice), before + 200e6, "winner got full pot");
        assertEq(token.balanceOf(address(escrow)), 0, "escrow emptied");
    }

    function testDrawRefundsBoth() public {
        vm.prank(admin); escrow.openMatch(matchId, alice, bob);
        vm.prank(alice); escrow.stake(matchId, 50e6);
        vm.prank(bob); escrow.stake(matchId, 50e6);
        vm.prank(admin); escrow.draw(matchId);
        assertEq(token.balanceOf(alice), 1000e6, "alice refunded");
        assertEq(token.balanceOf(bob), 1000e6, "bob refunded");
    }

    function testNonAdminCannotSettle() public {
        vm.prank(admin); escrow.openMatch(matchId, alice, bob);
        vm.prank(alice); escrow.stake(matchId, 100e6);
        vm.prank(bob); escrow.stake(matchId, 100e6);
        vm.prank(alice); vm.expectRevert(DreamDuelEscrow.NotAdmin.selector);
        escrow.settle(matchId, alice);
    }

    function testWrongStakeReverts() public {
        vm.prank(admin); escrow.openMatch(matchId, alice, bob);
        vm.prank(alice); escrow.stake(matchId, 100e6);
        vm.prank(bob); vm.expectRevert(DreamDuelEscrow.WrongStake.selector);
        escrow.stake(matchId, 200e6);
    }

    function testStrangerCannotStake() public {
        vm.prank(admin); escrow.openMatch(matchId, alice, bob);
        vm.prank(address(0x3333)); vm.expectRevert(DreamDuelEscrow.InvalidPlayer.selector);
        escrow.stake(matchId, 100e6);
    }

    function testCannotStakeTwice() public {
        vm.prank(admin); escrow.openMatch(matchId, alice, bob);
        vm.prank(alice); escrow.stake(matchId, 100e6);
        vm.prank(alice); vm.expectRevert(DreamDuelEscrow.AlreadyStaked.selector);
        escrow.stake(matchId, 100e6);
    }

    function testCannotSettleBeforeBothStake() public {
        vm.prank(admin); escrow.openMatch(matchId, alice, bob);
        vm.prank(alice); escrow.stake(matchId, 100e6);
        vm.prank(admin); vm.expectRevert(DreamDuelEscrow.WrongStake.selector);
        escrow.settle(matchId, alice);
    }

    function testSelfRefundAfterExpiry() public {
        vm.prank(admin); escrow.openMatch(matchId, alice, bob);
        vm.prank(alice); escrow.stake(matchId, 100e6);
        vm.prank(bob); escrow.stake(matchId, 100e6);
        vm.warp(block.timestamp + 301);
        vm.prank(alice); escrow.refund(matchId);
        assertEq(token.balanceOf(alice), 1000e6, "alice refunded");
        assertEq(token.balanceOf(bob), 1000e6, "bob refunded");
    }

    function testRefundTooEarlyReverts() public {
        vm.prank(admin); escrow.openMatch(matchId, alice, bob);
        vm.prank(alice); escrow.stake(matchId, 100e6);
        vm.prank(bob); escrow.stake(matchId, 100e6);
        vm.prank(alice); vm.expectRevert(DreamDuelEscrow.RefundNotDue.selector);
        escrow.refund(matchId);
    }
}
