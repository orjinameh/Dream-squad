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
    uint256 constant PRICE_HALF = 500_000;   // 0.50 — even match => 100% profit
    uint256 constant PRICE_FAV = 824_000;    // 0.824 — favorite => ~21% profit

    function setUp() public {
        token = new MockTAUSDC();
        escrow = new DreamDuelEscrow(address(token), admin, 900); // 15 min
        token.mint(alice, 1000e6);
        vm.prank(alice); token.approve(address(escrow), type(uint256).max);
    }

    // v4: stake carries the position's own windowClose (venue expiry). Most tests
    // keep the legacy +900s behaviour via this helper.
    function winClose() internal view returns (uint256) { return block.timestamp + 900; }

    // ── Position lifecycle ────────────────────────────────────────────────────

    function testStakeOpensPositionLockedForWindow() public {
        vm.prank(alice); escrow.stake(pid, 100e6, PRICE_HALF, winClose());
        DreamDuelEscrow.Position memory p = escrow.position(pid);
        assertEq(p.owner, alice);
        assertEq(p.balance, 100e6);
        assertEq(p.entryPrice, PRICE_HALF);
        assertEq(p.open, true);
        assertEq(p.settled, false);
        assertEq(p.won, 0);
        assertEq(uint256(p.windowClose - p.windowOpen), 900, "window 15 min");
        assertEq(token.balanceOf(address(escrow)), 100e6, "tUSDC held");
        assertEq(escrow.totalOwedToPlayers(), 100e6, "owed to player");
    }

    function testTopUpAddsFuelDuringWindow() public {
        vm.prank(alice); escrow.stake(pid, 100e6, PRICE_HALF, winClose());
        vm.warp(block.timestamp + 300);
        vm.prank(alice); escrow.stake(pid, 50e6, PRICE_HALF, winClose());
        assertEq(escrow.position(pid).balance, 150e6);
        assertEq(escrow.totalOwedToPlayers(), 150e6);
    }

    function testStrangerCannotTopUp() public {
        vm.prank(alice); escrow.stake(pid, 100e6, PRICE_HALF, winClose());
        vm.prank(address(0x1234)); vm.expectRevert(DreamDuelEscrow.NotOwner.selector);
        escrow.stake(pid, 50e6, PRICE_HALF, winClose());
    }

    function testZeroStakeReverts() public {
        vm.prank(alice); vm.expectRevert(DreamDuelEscrow.ZeroAmount.selector);
        escrow.stake(pid, 0, PRICE_HALF, winClose());
    }

    function testBadEntryPriceReverts() public {
        vm.prank(alice); vm.expectRevert(DreamDuelEscrow.BadEntryPrice.selector);
        escrow.stake(pid, 100e6, 0, winClose());
        vm.prank(alice); vm.expectRevert(DreamDuelEscrow.BadEntryPrice.selector);
        escrow.stake(pid, 100e6, 1e6 + 1, winClose());
    }

    function testBadWindowCloseReverts() public {
        vm.prank(alice); vm.expectRevert(DreamDuelEscrow.BadWindowClose.selector);
        escrow.stake(pid, 100e6, PRICE_HALF, uint256(block.timestamp));
    }

    function testVenueBackedCloseSettlesSoonAfterExpiry() public {
        // v4: windowClose = venue expiry (~60s out), not the global 900s — so
        // settlement unlocks the moment the venue's result is final.
        vm.prank(alice); escrow.stake(pid, 100e6, PRICE_HALF, uint256(block.timestamp + 60));
        assertEq(uint256(escrow.position(pid).windowClose - block.timestamp), 60, "venue expiry backed");
        vm.prank(admin); vm.expectRevert(DreamDuelEscrow.WindowNotOver.selector);
        escrow.settleWindow(pid, true);
        vm.warp(block.timestamp + 61);
        vm.prank(admin); escrow.settleWindow(pid, true);
        assertEq(escrow.position(pid).settled, true);
        assertEq(escrow.position(pid).won, 1);
    }

    function testBalanceUnchangedMidWindow() public {
        vm.prank(alice); escrow.stake(pid, 100e6, PRICE_HALF, winClose());
        vm.warp(block.timestamp + 600);
        // Combat matches/rounds happen here — balance stays fixed until settlement.
        assertEq(escrow.position(pid).balance, 100e6);
        assertEq(escrow.totalOwedToPlayers(), 100e6);
    }

    // ── Settlement is the ONLY money decision ─────────────────────────────────

    function _fundPool(uint256 amount) internal {
        vm.prank(admin); token.mint(admin, amount);
        vm.prank(admin); token.approve(address(escrow), type(uint256).max);
        vm.prank(admin); escrow.topUpProfitPool(amount);
    }

    function testWinPaysDexPayoutAt50_50() public {
        vm.prank(alice); escrow.stake(pid, 100e6, PRICE_HALF, winClose());
        _fundPool(100e6);
        uint256 before = token.balanceOf(alice);
        vm.warp(block.timestamp + 901);
        vm.prank(admin); escrow.settleWindow(pid, true);
        assertEq(escrow.position(pid).won, 1);
        // 100 / 0.50 = 200 — stake back + 100 profit
        vm.prank(alice); escrow.withdraw(pid);
        assertEq(token.balanceOf(alice), before + 200e6, "stake + 100% profit");
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function testWinPaysDexPayoutForFavorite() public {
        // Entry at 0.824 (strong favorite) => 100/0.824 = 121.36 => +21.4% profit
        vm.prank(alice); escrow.stake(pid, 100e6, PRICE_FAV, winClose());
        _fundPool(50e6);
        uint256 before = token.balanceOf(alice);
        vm.warp(block.timestamp + 901);
        vm.prank(admin); escrow.settleWindow(pid, true);
        vm.prank(alice); escrow.withdraw(pid);
        uint256 expected = (100e6 * 1e6) / PRICE_FAV;
        assertEq(token.balanceOf(alice), before + expected, "stake / entryPrice");
    }

    function testWithdrawCappedByEscrowBalance() public {
        // Only the stake was funded (no profit pool): a win at 0.5 wants 200 but
        // the escrow only holds 100 — it pays what it holds, no insolvency.
        vm.prank(alice); escrow.stake(pid, 100e6, PRICE_HALF, winClose());
        uint256 before = token.balanceOf(alice);
        vm.warp(block.timestamp + 901);
        vm.prank(admin); escrow.settleWindow(pid, true);
        vm.prank(alice); escrow.withdraw(pid);
        assertEq(token.balanceOf(alice), before + 100e6, "capped at holdings");
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(escrow.totalOwedToPlayers(), 0);
    }

    function testProfitPoolCoversFullPayout() public {
        _fundPool(200e6);
        vm.prank(alice); escrow.stake(pid, 100e6, PRICE_HALF, winClose());
        vm.warp(block.timestamp + 901);
        vm.prank(admin); escrow.settleWindow(pid, true);
        uint256 aliceBefore = token.balanceOf(alice);
        vm.prank(alice); escrow.withdraw(pid);
        assertEq(token.balanceOf(alice), aliceBefore + 200e6, "full DEX payout from pooled funds");
        assertEq(token.balanceOf(address(escrow)), 100e6, "leftover equals profit pool remainder");
    }

    function testLossForfeitsToAdmin() public {
        vm.prank(alice); escrow.stake(pid, 100e6, PRICE_HALF, winClose());
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
        vm.prank(alice); escrow.stake(pid, 100e6, PRICE_HALF, winClose());
        vm.prank(admin); vm.expectRevert(DreamDuelEscrow.WindowNotOver.selector);
        escrow.settleWindow(pid, true);
    }

    function testNonAdminCannotSettle() public {
        vm.prank(alice); escrow.stake(pid, 100e6, PRICE_HALF, winClose());
        vm.warp(block.timestamp + 901);
        vm.prank(alice); vm.expectRevert(DreamDuelEscrow.NotAdmin.selector);
        escrow.settleWindow(pid, true);
    }

    function testTopUpAfterCloseReverts() public {
        vm.prank(alice); escrow.stake(pid, 100e6, PRICE_HALF, winClose());
        vm.warp(block.timestamp + 901);
        vm.prank(alice); vm.expectRevert(DreamDuelEscrow.WindowNotOver.selector);
        escrow.stake(pid, 10e6, PRICE_HALF, winClose());
    }

    function testTopUpProfitPoolOnlyAdmin() public {
        vm.prank(admin); token.mint(admin, 50e6);
        vm.prank(admin); token.approve(address(escrow), type(uint256).max);
        vm.prank(admin); escrow.topUpProfitPool(50e6);
        assertEq(token.balanceOf(address(escrow)), 50e6);
        vm.prank(alice); vm.expectRevert(DreamDuelEscrow.NotAdmin.selector);
        escrow.topUpProfitPool(1e6);
    }

    function testSetWindowLengthOnlyAdmin() public {
        vm.prank(admin); escrow.setWindowLength(600);
        assertEq(escrow.windowLength(), 600);
        vm.prank(alice); vm.expectRevert(DreamDuelEscrow.NotAdmin.selector);
        escrow.setWindowLength(300);
    }
}