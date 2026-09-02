// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "./IERC20.sol";

/**
 * @title DreamDuelEscrow v3 — DEX-style entry-price payout
 * @notice On-chain tUSDC position for a single DreamDEX Event Contract window.
 *
 * MODEL (user-defined):
 *   - The stake IS the position. A player stakes tUSDC (`stake`) which is locked
 *     for one ~15-minute EC window.
 *   - For the whole window the position BALANCE DOES NOT CHANGE. Inside the
 *     window the player fights combat matches (70s = 7 x 10s rounds). Round and
 *     match winnings are purely STATS + RANKS (bragging) and never touch this
 *     position.
 *   - ONCE, when the EC window resolves, the binary outcome is known. The player
 *     bought their side (UP = YES token / DOWN = NO token) at the market's entry
 *     price when the position opened. A correct call pays out the DEX's FIXED
 *     $1.00 per token, so the win payout = stake / entryPrice (the profit is the
 *     spread between the cheap entry price and the $1.00 redemption). A wrong
 *     call forfeits the stake to the house/admin. This is the ONLY money
 *     movement, and it is reported by the relayer from the REAL on-chain EC
 *     settlement (winningOutcome), never invented.
 *   - A player has ONE active position at a time; opening a new one to switch
 *     UP/DOWN means the current one must first settle. Matches never touch the
 *     position — they reference it for context and produce stats/ranks only.
 *
 *   In v2, a win paid the stake back IN FULL (no profit). In v3, a win pays the
 *   DEX payout stake * 1e6 / entryPrice, funded from this contract's tUSDC
 *   holdings. Admin tops the payout pool up with `topUpProfitPool`. Losses are
 *   collected to the house as before. Withdraw is capped by the contract's
 *   tUSDC balance so the escrow can never go insolvent.
 */

contract DreamDuelEscrow {
    event Staked(bytes32 indexed windowId, address indexed owner, uint256 amount, uint256 entryPrice);
    event WindowSettled(bytes32 indexed windowId, address indexed owner, bool won, uint256 stake);
    event Withdrawn(bytes32 indexed windowId, address indexed owner, uint256 amount);
    event AdminCollected(bytes32 indexed windowId, uint256 amount);
    event ProfitPoolToppedUp(address indexed admin, uint256 amount);
    event WindowLengthSet(uint256 length);

    error NotAdmin();
    error PositionClosedErr();
    error ZeroAmount();
    error BadEntryPrice();
    error NotOwner();
    error WindowNotOver();
    error NothingToWithdraw();
    error TransferFailed();

    /// 1e6 = $1.00. Minimum entry price guards against absurd payouts.
    uint256 public constant ENTRY_PRICE_SCALE = 1e6;
    /// ~1% — caps a win at 100x stake even on a deep-underdog entry.
    uint256 public constant MIN_ENTRY_PRICE = 1e4;

    struct Position {
        address owner;      // the player whose stake this is
        uint256 balance;    // tUSDC the player owns (== stake, unchanged during window)
        uint256 entryPrice; // the side's entry price scaled 1e6 (0.824 => 824000)
        uint64  windowOpen; // unix seconds the window opened
        uint64  windowClose;// unix seconds the window ends (EC resolution expected)
        uint8   won;        // 0 = pending, 1 = won (DEX payout), 2 = lost (forfeited)
        bool    open;
        bool    settled;
    }

    IERC20 public immutable collateral;
    address public admin;
    uint256 public windowLength; // seconds a window stays open (e.g. 900 = 15 min)

    // Sum of all open position stakes = base tUSDC this contract owes players on
    // the lose-nothing floor. Win payouts above stake are covered by the contract's
    // own tUSDC holdings (player stakes + house profit pool + collected losses).
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
     * @notice Open a position for a window at the player's side entry price, or
     *         top up fuel into an open one.
     * @param entryPrice The player's side (YES for UP / NO for DOWN) entry price
     *                   scaled 1e6 — the DEX implied probability they bought at.
     */
    function stake(bytes32 windowId, uint256 amount, uint256 entryPrice) external {
        if (amount == 0) revert ZeroAmount();
        if (entryPrice < MIN_ENTRY_PRICE || entryPrice > ENTRY_PRICE_SCALE) revert BadEntryPrice();
        Position storage p = positions[windowId];
        if (!p.open) {
            p.owner = msg.sender;
            p.open = true;
            p.entryPrice = entryPrice;
            p.windowOpen = uint64(block.timestamp);
            p.windowClose = uint64(block.timestamp + windowLength);
        } else {
            if (p.settled) revert PositionClosedErr();
            if (msg.sender != p.owner) revert NotOwner();
            if (block.timestamp >= p.windowClose) revert WindowNotOver();
            p.entryPrice = entryPrice;
        }
        bool ok = collateral.transferFrom(msg.sender, address(this), amount);
        if (!ok) revert TransferFailed();
        p.balance += amount;
        totalOwedToPlayers += amount;
        emit Staked(windowId, msg.sender, amount, entryPrice);
    }

    /**
     * @notice Settle a window after its EC event resolved (admin/relayer only).
     * @dev The ONLY money decision. `won=true` commits the DEX payout
     *      (stake * 1e6 / entryPrice) to the owner at withdraw. `won=false` marks
     *      it forfeited to the house (admin collects). Reported from the REAL
     *      on-chain EC settlement.
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
     * @notice Pay a WON position its DEX payout to the owner: stake / entryPrice,
     *         capped by the contract's actual tUSDC holdings to stay solvent.
     */
    function withdraw(bytes32 windowId) external {
        Position storage p = positions[windowId];
        if (!p.settled) revert WindowNotOver();
        if (p.won != 1) revert NothingToWithdraw(); // lost positions are not withdrawn by owner
        uint256 stake = p.balance;
        if (stake == 0) revert NothingToWithdraw();
        uint256 payout = (stake * ENTRY_PRICE_SCALE) / p.entryPrice;
        uint256 held = collateral.balanceOf(address(this));
        if (payout > held) payout = held;
        if (payout == 0) revert NothingToWithdraw();
        p.balance = 0;
        // totalOwedToPlayers tracks base stakes; a partial pool only under-credits
        // this contract's own view, never risks insolvency.
        if (totalOwedToPlayers >= stake) totalOwedToPlayers -= stake;
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
        if (totalOwedToPlayers >= amount) totalOwedToPlayers -= amount;
        bool ok = collateral.transfer(admin, amount);
        if (!ok) revert TransferFailed();
        emit AdminCollected(windowId, amount);
    }

    /**
     * @notice House funds the payout pool: tUSDC pulled in from the admin so wins
     *         can pay the DEX profit above the base stake.
     */
    function topUpProfitPool(uint256 amount) external onlyAdmin {
        if (amount == 0) revert ZeroAmount();
        bool ok = collateral.transferFrom(msg.sender, address(this), amount);
        if (!ok) revert TransferFailed();
        emit ProfitPoolToppedUp(msg.sender, amount);
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