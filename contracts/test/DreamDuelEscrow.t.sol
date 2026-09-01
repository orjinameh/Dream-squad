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
    bytes32 pid = keccak256("UP-BYTE-0x0001"); // one player's UP position

    function setUp() public {
        token = new MockTAUSDC();
        escrow = new DreamDuelEscrow(address(token), admin, 900); // 15 min
        token.mint(alice, 1000e6);
        vm.prank(alice); token.approve(address(escrow), type(uint256).max);
    }

    // ── Position lifecycle ────────────────────────────────────────────────────

    function testStakeOpensPositionLockedForWindow() public {
        vm.prank(alice); escrow.stake(pid, 100e6);
        DreamDuelEscrow.Position memory p = escrow.position(pid);
        assertEq(p.owner, alice);
        assertEq(p.balance, 100e6);
        assertEq(p.open, true);
        assertEq(p.settled, false);
        assertEq(p.won, 0);
        assertEq(uint256(p.windowClose - p.windowOpen), 900, "window 15 min");
        assertEq(token.balanceOf(address(escrow)), 100e6, "tUSDC held");
        assertEq(escrow.totalOwedToPlayers(), 100e6, "owed to player");
    }

    function testTopUpAddsFuelDuringWindow() public {
        vm.prank(alice); escrow.stake(pid, 100e6);
        vm.warp(block.timestamp + 300);
        vm.prank(alice); escrow.stake(pid, 50e6);
        assertEq(escrow.position(pid).balance, 150e6);
        assertEq(escrow.totalOwedToPlayers(), 150e6);
    }

    function testStrangerCannotTopUp() public {
        vm.prank(alice); escrow.stake(pid, 100e6);
        vm.prank(address(0x1234)); vm.expectRevert(DreamDuelEscrow.NotOwner.selector);
        escrow.stake(pid, 50e6);
    }

    // ── Balance does NOT change during the window ─────────────────────────────

    function testBalanceUnchangedMidWindow() public {
        vm.prank(alice); escrow.stake(pid, 100e6);
        vm.warp(block.timestamp + 600);
        // Combat matches/rounds happen here — balance stays fixed until settlement.
        assertEq(escrow.position(pid).balance, 100e6);
        assertEq(escrow.totalOwedToPlayers(), 100e6);
    }

    // ── Settlement is the ONLY money decision ─────────────────────────────────

    function testWinReturnsStakeInFull() public {
        vm.prank(alice); escrow.stake(pid, 100e6);
        uint256 before = token.balanceOf(alice);
        vm.warp(block.timestamp + 901);
        vm.prank(admin); escrow.settleWindow(pid, true);
        assertEq(escrow.position(pid).won, 1);
        assertEq(escrow.position(pid).settled, true);
        vm.prank(alice); escrow.withdraw(pid);
        assertEq(token.balanceOf(alice), before + 100e6, "full stake returned");
        assertEq(escrow.totalOwedToPlayers(), 0);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function testLossForfeitsToAdmin() public {
        vm.prank(alice); escrow.stake(pid, 100e6);
        uint256 adminBefore = token.balanceOf(admin);
        vm.warp(block.timestamp + 901);
        vm.prank(admin); escrow.settleWindow(pid, false);
        assertEq(escrow.position(pid).won, 2);
        // alice cannot withdraw a lost position
        vm.prank(alice); vm.expectRevert(DreamDuelEscrow.NothingToWithdraw.selector);
        escrow.withdraw(pid);
        // admin collects the forfeited stake
        vm.prank(admin); escrow.collectLost(pid);
        assertEq(token.balanceOf(admin), adminBefore + 100e6, "admin collected forfeited stake");
        assertEq(escrow.totalOwedToPlayers(), 0);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function testCannotSettleBeforeWindowClose() public {
        vm.prank(alice); escrow.stake(pid, 100e6);
        vm.prank(admin); vm.expectRevert(DreamDuelEscrow.WindowNotOver.selector);
        escrow.settleWindow(pid, true);
    }

    function testNonAdminCannotSettle() public {
        vm.prank(alice); escrow.stake(pid, 100e6);
        vm.warp(block.timestamp + 901);
        vm.prank(alice); vm.expectRevert(DreamDuelEscrow.NotAdmin.selector);
        escrow.settleWindow(pid, true);
    }

    function testWinConservation() public {
        vm.prank(alice); escrow.stake(pid, 100e6);
        vm.warp(block.timestamp + 901);
        vm.prank(admin); escrow.settleWindow(pid, true);
        // after settle, still owed 100 until withdrawn; escrow still holds 100
        assertEq(escrow.totalOwedToPlayers(), 100e6);
        assertEq(token.balanceOf(address(escrow)), 100e6);
        vm.prank(alice); escrow.withdraw(pid);
        assertEq(escrow.totalOwedToPlayers(), 0);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function testLossConservation() public {
        vm.prank(alice); escrow.stake(pid, 100e6);
        vm.warp(block.timestamp + 901);
        vm.prank(admin); escrow.settleWindow(pid, false);
        vm.prank(admin); escrow.collectLost(pid);
        assertEq(escrow.totalOwedToPlayers(), 0);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function testZeroStakeReverts() public {
        vm.prank(alice); vm.expectRevert(DreamDuelEscrow.ZeroAmount.selector);
        escrow.stake(pid, 0);
    }

    function testWithdrawNeedsSettlement() public {
        vm.prank(alice); escrow.stake(pid, 100e6);
        vm.prank(alice); vm.expectRevert(DreamDuelEscrow.WindowNotOver.selector);
        escrow.withdraw(pid);
    }

    function testTopUpAfterCloseReverts() public {
        vm.prank(alice); escrow.stake(pid, 100e6);
        vm.warp(block.timestamp + 901);
        vm.prank(alice); vm.expectRevert(DreamDuelEscrow.WindowNotOver.selector);
        escrow.stake(pid, 10e6);
    }

    function testSetWindowLengthOnlyAdmin() public {
        vm.prank(admin); escrow.setWindowLength(600);
        assertEq(escrow.windowLength(), 600);
        vm.prank(alice); vm.expectRevert(DreamDuelEscrow.NotAdmin.selector);
        escrow.setWindowLength(300);
    }
}
