// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "./IERC20.sol";

/**
 * @title DreamDuelEscrow v2 — window-keyed EC binary position
 * @notice On-chain tUSDC position for a single DreamDEX Event Contract window.
 *
 * MODEL (user-defined):
 *   - The stake IS the position. A player stakes tUSDC (`stake`) which is locked
 *     for one ~15-minute EC window.
 *   - For the whole window the position BALANCE DOES NOT CHANGE. Inside the
 *     window the player fights combat matches (70s = 7 x 10s rounds). Round and
 *     match winnings are purely STATS + RANKS (bragging) and never touch this
 *     position.
 *   - ONCE, when the EC window resolves, the binary outcome is known. If the
 *     player's chosen side won, the stake is returned IN FULL (paid out). If it
 *     lost, the stake is forfeited and collectable by the house/admin. This is
 *     the ONLY money movement, and it is reported by the relayer from the REAL
 *     on-chain EC settlement (winningOutcome), never invented.
 *   - A player has ONE active position at a time; opening a new one to switch
 *     UP/DOWN means the current one must first settle. Matches never touch the
 *     position — they reference it for context and produce stats/ranks only.
 *
 * CONSERVATION: an open position's balance is exactly the tUSDC held by this
 * contract on the player's behalf. A win pays it back; a loss leaves it for
 * the admin to sweep. No inflation, no counterparty ledger required.
 */

contract DreamDuelEscrow {
    event Staked(bytes32 indexed windowId, address indexed owner, uint256 amount);
    event WindowSettled(bytes32 indexed windowId, address indexed owner, bool won, uint256 stake);
    event Withdrawn(bytes32 indexed windowId, address indexed owner, uint256 amount);
    event AdminCollected(bytes32 indexed windowId, uint256 amount);
    event WindowLengthSet(uint256 length);

    error NotAdmin();
    error PositionClosedErr();
    error ZeroAmount();
    error NotOwner();
    error WindowNotOver();
    error NothingToWithdraw();
    error TransferFailed();

    struct Position {
        address owner;      // the player whose stake this is
        uint256 balance;    // tUSDC the player owns (== stake, unchanged during window)
        uint64  windowOpen; // unix seconds the window opened
        uint64  windowClose;// unix seconds the window ends (EC resolution expected)
        uint8   won;        // 0 = pending, 1 = won (returned full), 2 = lost (forfeited)
        bool    open;
        bool    settled;
    }

    IERC20 public immutable collateral;
    address public admin;
    uint256 public windowLength; // seconds a window stays open (e.g. 900 = 15 min)

    // Sum of all open position balances = total tUSDC this contract owes players.
    // Conservation: collateral.balanceOf(this) == sum(open positions).
    uint256 public totalOwedToPlayers;

    mapping(bytes32 => Position) public positions;

    constructor(address collateral_, address admin_, uint256 windowLength_) {
        collateral = IERC20(collateral_);
        admin = admin_;
        windowLength = windowLength_;
        emit WindowLengthSet(windowLength_);
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    /**
     * @notice Open a position for a window, or top up fuel into an open one.
     */
    function stake(bytes32 windowId, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        Position storage p = positions[windowId];
        if (!p.open) {
            p.owner = msg.sender;
            p.open = true;
            p.windowOpen = uint64(block.timestamp);
            p.windowClose = uint64(block.timestamp + windowLength);
        } else {
            if (p.settled) revert PositionClosedErr();
            if (msg.sender != p.owner) revert NotOwner();
            if (block.timestamp >= p.windowClose) revert WindowNotOver();
        }
        bool ok = collateral.transferFrom(msg.sender, address(this), amount);
        if (!ok) revert TransferFailed();
        p.balance += amount;
        totalOwedToPlayers += amount;
        emit Staked(windowId, msg.sender, amount);
    }

    /**
     * @notice Settle a window after its EC event resolved (admin/relayer only).
     * @dev The ONLY money decision. `won=true` keeps the stake owed IN FULL to the
     *      player (they withdraw it). `won=false` marks it forfeited to the house
     *      (admin collects). Reported from the REAL on-chain EC settlement.
     */
    function settleWindow(bytes32 windowId, bool won) external onlyAdmin {
        Position storage p = positions[windowId];
        if (!p.open || p.settled) revert PositionClosedErr();
        if (block.timestamp < p.windowClose) revert WindowNotOver();
        p.won = won ? 1 : 2;
        p.settled = true;
        emit WindowSettled(windowId, p.owner, won, p.balance);
    }

    /**
     * @notice Pay a WON position's stake IN FULL to its owner.
     */
    function withdraw(bytes32 windowId) external {
        Position storage p = positions[windowId];
        if (!p.settled) revert WindowNotOver();
        if (p.won != 1) revert NothingToWithdraw(); // lost positions are not withdrawn by owner
        uint256 payout = p.balance;
        if (payout == 0) revert NothingToWithdraw();
        p.balance = 0;
        totalOwedToPlayers -= payout;
        bool ok = collateral.transfer(p.owner, payout);
        if (!ok) revert TransferFailed();
        emit Withdrawn(windowId, p.owner, payout);
    }

    /**
     * @notice Collect a LOST position's forfeited stake to the house (admin only).
     */
    function collectLost(bytes32 windowId) external onlyAdmin {
        Position storage p = positions[windowId];
        if (!p.settled) revert WindowNotOver();
        if (p.won != 2) revert PositionClosedErr(); // only lost positions are collectible by house
        uint256 amount = p.balance;
        if (amount == 0) revert NothingToWithdraw();
        p.balance = 0;
        totalOwedToPlayers -= amount;
        bool ok = collateral.transfer(admin, amount);
        if (!ok) revert TransferFailed();
        emit AdminCollected(windowId, amount);
    }

    function setWindowLength(uint256 length) external onlyAdmin {
        windowLength = length;
        emit WindowLengthSet(length);
    }

    function setAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert NotAdmin();
        admin = newAdmin;
    }

    /** @dev Decoded position for a window (public mapping getter returns a tuple). */
    function position(bytes32 windowId) external view returns (Position memory) {
        return positions[windowId];
    }
}
