// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "./IERC20.sol";
/**
 * @title DreamDuelEscrow
 * @notice On-chain tUSDC escrow that holds both players' pledges for a
 *         DreamDuel PvP match and pays the winner the full pot on settlement.
 *
 * Flow:
 *   1. Both players approve this contract to spend their tUSDC.
 *   2. Each player calls stake(matchId) with the SAME amount; the contract
 *      pulls their tUSDC into escrow (transferFrom from msg.sender).
 *   3. The match resolves over real DreamDEX Event-Contract price deltas in
 *      the backend. The configured admin/relayer calls settle(matchId, winner)
 *      to pay the winner both stakes, or draw(matchId) to refund everyone.
 *   4. If neither side settles within the refund delay, either player can
 *      self-serve call refund(matchId) to escape a stuck lobby.
 *
 * The contract NEVER makes asset-price decisions itself — it only escrows and
 * disburses based on the authority of the relayer that reports a match outcome.
 */
contract DreamDuelEscrow {
    event Staked(bytes32 indexed matchId, address indexed player, uint256 amount);
    event Settled(bytes32 indexed matchId, address indexed winner, uint256 amount);
    event Drawn(bytes32 indexed matchId);
    event Refunded(bytes32 indexed matchId, address indexed player, uint256 amount);
    event RefundDelaySet(uint256 delay);

    error NotAdmin();
    error InvalidPlayer();
    error AlreadyStaked();
    error NotSettled();
    error MatchNotOpen();
    error WrongStake();
    error RefundNotDue();
    error TransferFailed();
    error ZeroAmount();
    error NotParticipant();

    struct Match {
        address playerA;
        address playerB;
        uint256 stake;      // per-player collateral amount (raw tUSDC units)
        bool stakedA;
        bool stakedB;
        bool settled;
        bool drawn;
        uint256 createdAt;
    }

    IERC20 public immutable collateral;
    address public admin;
    uint256 public refundDelay; // seconds a player must wait before self-refunding

    mapping(bytes32 => Match) public matches;

    constructor(address collateral_, address admin_, uint256 refundDelay_) {
        collateral = IERC20(collateral_);
        admin = admin_;
        refundDelay = refundDelay_;
        emit RefundDelaySet(refundDelay_);
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    /**
     * @notice Open a match and register both participants.
     * @dev Must be called before either player stakes. Only admin can open.
     */
    function openMatch(bytes32 matchId, address playerA, address playerB) external onlyAdmin {
        Match storage m = matches[matchId];
        if (m.playerA != address(0) || m.playerB != address(0)) revert MatchNotOpen();
        if (playerA == address(0) || playerB == address(0)) revert InvalidPlayer();
        if (playerA == playerB) revert InvalidPlayer();
        m.playerA = playerA;
        m.playerB = playerB;
        m.createdAt = block.timestamp;
    }

    /**
     * @notice Pull `amount` tUSDC from the caller into escrow for a match.
     * @dev The caller must be a registered participant and must have approved
     *      this contract. The first stake sets the size; the second must match.
     */
    function stake(bytes32 matchId, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        Match storage m = matches[matchId];
        if (m.settled || m.drawn) revert NotSettled();
        if (m.createdAt == 0 || msg.sender != m.playerA && msg.sender != m.playerB) revert InvalidPlayer();

        // First stake fixes the amount; the second must match it.
        if (m.stake == 0) {
            m.stake = amount;
        } else if (amount != m.stake) {
            revert WrongStake();
        }
        if (msg.sender == m.playerA) {
            if (m.stakedA) revert AlreadyStaked();
            m.stakedA = true;
        } else {
            if (m.stakedB) revert AlreadyStaked();
            m.stakedB = true;
        }
        bool ok = collateral.transferFrom(msg.sender, address(this), amount);
        if (!ok) revert TransferFailed();
        emit Staked(matchId, msg.sender, amount);
    }

    /**
     * @notice Settle a match, paying the winning player the entire pot.
     * @dev Security: BOTH players must have staked before settling, otherwise
     *      the pot math is unsafe. `winner` may be either participant (this
     *      keeps the contract free of asset-price logic).
     */
    function settle(bytes32 matchId, address winner) external onlyAdmin {
        Match storage m = matches[matchId];
        if (m.settled || m.drawn) revert NotSettled();
        if (winner != m.playerA && winner != m.playerB) revert NotParticipant();
        if (!m.stakedA || !m.stakedB) revert WrongStake();
        m.settled = true;
        uint256 pot = m.stake * 2;
        bool ok = collateral.transfer(winner, pot);
        if (!ok) revert TransferFailed();
        emit Settled(matchId, winner, pot);
    }

    /** @notice Refund both players their stakes (e.g. a draw). Admin only. */
    function draw(bytes32 matchId) external onlyAdmin {
        Match storage m = matches[matchId];
        if (m.settled || m.drawn) revert NotSettled();
        if (!m.stakedA && !m.stakedB) revert WrongStake();
        m.drawn = true;
        if (m.stakedA) {
            bool ok = collateral.transfer(m.playerA, m.stake);
            if (!ok) revert TransferFailed();
        }
        if (m.stakedB) {
            bool ok = collateral.transfer(m.playerB, m.stake);
            if (!ok) revert TransferFailed();
        }
        emit Drawn(matchId);
    }

    /**
     * @notice Self-serve escape hatch: any participant may trigger a full refund
     *         of both stakes if the match was never settled/drawn within
     *         refundDelay of opening.
     * @dev Guards against a permanently stuck lobby. Marking drawn means neither
     *      player can double-extract.
     */
    function refund(bytes32 matchId) external {
        Match storage m = matches[matchId];
        if (m.settled || m.drawn) revert NotSettled();
        if (msg.sender != m.playerA && msg.sender != m.playerB) revert NotParticipant();
        if (block.timestamp < m.createdAt + refundDelay) revert RefundNotDue();
        m.drawn = true;
        if (m.stakedA) {
            bool ok = collateral.transfer(m.playerA, m.stake);
            if (!ok) revert TransferFailed();
        }
        if (m.stakedB) {
            bool ok = collateral.transfer(m.playerB, m.stake);
            if (!ok) revert TransferFailed();
        }
        emit Refunded(matchId, msg.sender, m.stake);
    }

    function setRefundDelay(uint256 delay) external onlyAdmin {
        refundDelay = delay;
        emit RefundDelaySet(delay);
    }

    function setAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert InvalidPlayer();
        admin = newAdmin;
    }
}
