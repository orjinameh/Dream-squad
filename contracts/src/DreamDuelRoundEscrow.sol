// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "./IERC20.sol";

/**
 * @title DreamDuelRoundEscrow — per-round EC staking with flippable calls
 * @notice On-chain tUSDC settlement for a DreamDEX fight played round-by-round.
 *
 * MODEL (user-defined):
 *   - A match has N rounds (e.g. 7). Each round the player stakes the SAME
 *     amount of tUSDC (`stakeRound(matchId, round, amount, entryPrice)`) and
 *     picks a side (UP/DOWN) — freely flippable between rounds.
 *   - Every round auto-settles when the EC resolves that round's outcome
 *     (`settleRound`). A WON round commits the DEX payout
 *     (stake * 1e6 / entryPrice) to the player's withdrawable balance. A LOST
 *     round forfeits that round's stake to the house (`collectLost`).
 *   - The player collects everything they won across the match's rounds via
 *     `withdraw(matchId)`. Base stakes and win payouts above stake are covered
 *     by this contract's tUSDC holdings (player stakes + house profit pool),
 *     so a win can never pay out more tUSDC than the contract holds.
 *
 *   Money is settled per ROUND (not once at window-close), mirroring a real
 *   CLOB hold-and-flip position: each round realizes its own PnL immediately.
 */

contract DreamDuelRoundEscrow {
    event RoundStaked(bytes32 indexed matchId, uint256 round, address indexed owner, uint256 amount, uint256 entryPrice);
    event RoundSettled(bytes32 indexed matchId, uint256 round, address indexed owner, bool won, uint256 amount);
    event MatchWithdrawn(bytes32 indexed matchId, address indexed owner, uint256 amount);
    event MatchLostCollected(bytes32 indexed matchId, uint256 amount);
    event ProfitPoolToppedUp(address indexed admin, uint256 amount);

    error NotAdmin();
    error ZeroAmount();
    error BadEntryPrice();
    error BadRound();
    error RoundAlreadyStaked();
    error RoundAlreadySettled();
    error NotOwner();
    error NothingToWithdraw();
    error TransferFailed();

    /// 1e6 = $1.00. Minimum entry price guards against absurd payouts.
    uint256 public constant ENTRY_PRICE_SCALE = 1e6;
    /// ~1% — caps a win at 100x stake even on a deep-underdog entry.
    uint256 public constant MIN_ENTRY_PRICE = 1e4;

    struct RoundLock {
        address owner;
        uint256 amount;      // this round's stake
        uint256 entryPrice;  // the side's entry price scaled 1e6
        uint8 won;           // 0 = pending, 1 = won (DEX payout credited), 2 = lost (forfeited)
        bool settled;
    }

    IERC20 public immutable collateral;
    address public admin;

    // matchId -> owner (the player entitled to this match's winnings)
    mapping(bytes32 => address) public matchOwner;
    // matchId -> total tUSDC the owner may withdraw from won rounds
    mapping(bytes32 => uint256) public withdrawable;
    // (matchId, round) -> round lock
    mapping(bytes32 => mapping(uint256 => RoundLock)) public locks;

    constructor(address collateral_, address admin_) {
        collateral = IERC20(collateral_);
        admin = admin_;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    /**
     * @notice Stake tUSDC for one round of a match, choosing your side's entry
     *         price. The same amount is staked per round (flippable UP/DOWN
     *         between rounds via a different entryPrice on each round).
     */
    function stakeRound(
        bytes32 matchId,
        uint256 round,
        uint256 amount,
        uint256 entryPrice
    ) external {
        if (amount == 0) revert ZeroAmount();
        if (round == 0) revert BadRound();
        if (entryPrice < MIN_ENTRY_PRICE || entryPrice > ENTRY_PRICE_SCALE) revert BadEntryPrice();
        RoundLock storage l = locks[matchId][round];
        if (l.settled) revert RoundAlreadySettled();
        if (l.amount != 0) revert RoundAlreadyStaked();

        address owner = matchOwner[matchId];
        if (owner == address(0)) {
            matchOwner[matchId] = msg.sender;
            owner = msg.sender;
        } else if (owner != msg.sender) {
            revert NotOwner();
        }

        l.owner = msg.sender;
        l.amount = amount;
        l.entryPrice = entryPrice;
        bool ok = collateral.transferFrom(msg.sender, address(this), amount);
        if (!ok) revert TransferFailed();
        emit RoundStaked(matchId, round, msg.sender, amount, entryPrice);
    }

    /**
     * @notice Admin resolves a round after the EC oracle reports the outcome.
     * @dev The ONLY money decision per round. `won=true` credits the DEX payout
     *      (stake * 1e6 / entryPrice) to the owner's withdrawable balance, so
     *      they can collect it. `won=false` marks this round's stake forfeited
     *      to the house (collectLost) and NOT payable to the owner.
     */
    function settleRound(bytes32 matchId, uint256 round, bool won) external onlyAdmin {
        RoundLock storage l = locks[matchId][round];
        if (l.settled) revert RoundAlreadySettled();
        if (l.amount == 0) revert BadRound();
        l.won = won ? 1 : 2;
        l.settled = true;
        if (won) {
            address owner = matchOwner[matchId];
            uint256 payout = (l.amount * ENTRY_PRICE_SCALE) / l.entryPrice;
            withdrawable[matchId] += payout;
            emit RoundSettled(matchId, round, owner, true, l.amount);
        } else {
            emit RoundSettled(matchId, round, l.owner, false, l.amount);
        }
    }

    /**
     * @notice Pay the owner everything they won across a match's settled rounds,
     *         capped by this contract's actual tUSDC holdings to stay solvent.
     */
    function withdraw(bytes32 matchId) external {
        uint256 amount = withdrawable[matchId];
        if (amount == 0) revert NothingToWithdraw();
        address owner = matchOwner[matchId];
        uint256 held = collateral.balanceOf(address(this));
        uint256 payout = amount > held ? held : amount;
        if (payout == 0) revert NothingToWithdraw();
        withdrawable[matchId] = amount - payout;
        bool ok = collateral.transfer(owner, payout);
        if (!ok) revert TransferFailed();
        emit MatchWithdrawn(matchId, owner, payout);
    }

    /**
     * @notice Admin collects a forfeited round's stake to the house.
     */
    function collectLost(bytes32 matchId, uint256 round) external onlyAdmin {
        RoundLock storage l = locks[matchId][round];
        if (!l.settled) revert BadRound();
        if (l.won != 2) revert BadRound(); // only lost rounds are collectible by house
        uint256 amount = l.amount;
        if (amount == 0) revert NothingToWithdraw();
        l.amount = 0;
        bool ok = collateral.transfer(admin, amount);
        if (!ok) revert TransferFailed();
        emit MatchLostCollected(matchId, amount);
    }

    /**
     * @notice House funds the payout pool: tUSDC pulled in from the admin so won
     *         rounds can pay the DEX profit above the base stake.
     */
    function topUpProfitPool(uint256 amount) external onlyAdmin {
        if (amount == 0) revert ZeroAmount();
        bool ok = collateral.transferFrom(msg.sender, address(this), amount);
        if (!ok) revert TransferFailed();
        emit ProfitPoolToppedUp(msg.sender, amount);
    }

    function setAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert NotAdmin();
        admin = newAdmin;
    }

    /** @dev Public read of a round lock (mapping getter returns a tuple). */
    function roundLock(bytes32 matchId, uint256 round) external view returns (RoundLock memory) {
        return locks[matchId][round];
    }
}
