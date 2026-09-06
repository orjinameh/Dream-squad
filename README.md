# ⚔️ DreamDuel
### *The 15-Second Web3 Combat Arcade Powered by dreamDEX Event Contracts*

DreamDuel turns high-velocity crypto event-speculation into a fast-paced, 1v1 retro fighting game. Built natively on the high-throughput **Somnia Network (Chain 50312)** for the **Somnia × dreamDEX Event Contracts Hackathon**, two gladiators (Player vs Player or Player vs Bot) leverage real-time order-book probability shifts to land bone-crushing combat strikes.

By engineering a **Hybrid State Engine with EOA Operator Delegation**, DreamDuel compresses complex, intimidating terminal grids into a frictionless gameplay loop — allowing casual players to trade real on-chain prediction tokens entirely through raw gaming inputs with **zero wallet popups mid-match**.

---

## 🔄 System Architecture & Data Flow

```
Browser (wagmi + RainbowKit) ─────────────────────────────────────────────
  └ 1v1 match flow: CHAR_SELECT → MATCH_TYPE → POSITION/approve → COMMIT(5s, pick + stake awaits receipt)
     → ACTIVE(10s locked trade) → resolve → DB paper credit → next round / KO / result → ONE final tUSDC payout

Next.js Route Handlers (server-authoritative)
  POST /api/matches/create|predict       Round lifecycle state machine (COMMIT→ACTIVE→EXECUTING)
  GET  /api/matches/state|history        State rehydration + round-by-round contract delta log
  POST /api/position                     EC position configuration (window stake + entry price)
  GET  /api/leaderboard                  Global LP/Elo mapping pipeline
```

---

## ⏱️ The 15-Second Round Lifecycle

Every round enforces a rigid, server-authoritative 15-second mechanical split that matches true binary-options trading parameters:

1. **Phase 1: COMMIT & Stake (0s – 5s) `[The Single Blocking Gate]`**
   * A 5-second countdown prompts player inputs. Clicking **"Attack"** maps to a dreamDEX Event Contract **YES order**, while clicking **"Defend"** maps to a **NO order**.
   * The background operator wallet automatically places the order on the dreamDEX router via the markets SDK trader.
   * **The Hard Gate:** the serverless handler enforces a strict await-confirmation lock on the stake receipt. The 10-second battle clock is pinned to the confirmation timestamp, eliminating nonce congestion and multi-round queue jams. If a stake fails, the server holds COMMIT with a `502` to force a clean client retry instead of fighting unstaked.

2. **Phase 2: BATTLE & Locked Trade (5s – 15s) `[Zero UI Popups]`**
   * Inputs are entirely frozen (`LOCKED — TRADE RUNNING`). Characters run clashing/charging animation loops while the embedded live chart streams ticks from the Somnia price oracle.
   * The trade position is locked on-chain, tracking the live implied-probability shifts of the player's YES/NO shares on the dreamDEX order book.

3. **Phase 3: RESOLUTION & Paper Credit (At Second 15)**
   * The countdown hits zero and triggers a temporary calculation freeze overlay.
   * The system computes the micro-value delta of the contract shares from the exact entry stamp to the exit stamp.
   * **The Optimization:** to completely bypass slow, erratic block latency mid-match, the engine logs wins/losses instantly as an **off-chain paper credit** inside the MongoDB match document (`match.playerBalance`), releasing the hit animations and updating health bars at lightning speed.

4. **Phase 4: GAME OVER & Final Payout**
   * Upon round 7 completion or a total knockout, the system calculates the player's final net earnings from the MongoDB ledger.
   * The operator wallet fires **exactly one real on-chain tUSDC transfer**, sending total match net-winnings directly to the player's primary wallet. An independent background worker sweeps and redeems the operator's contract shares off-line via `settleRoundStakes()`.

---

## 🛠️ The Production Stack

* **Frontend:** Next.js 15 (App Router), React 19, `wagmi v2` + RainbowKit.
* **Database & Ledger:** MongoDB via Mongoose 8. Atomic COMMIT→ACTIVE claims plus idempotency keys (`processedMatches`, per-round payout records) structurally guarantee exactly one locked position and one final payout per match.
* **On-Chain Infrastructure:** deployed natively on **Somnia Shannon Testnet (50312)**:
  * `OperatorRegistry` (`0x15C7...`): secures the one-time, non-custodial delegation permission profile.
  * `dreamDEX Router/CLOB` (`0x259f...`): processes immediate-or-cancel (IOC) contract token purchases crossing the live Event Contract order books.
  * `Collateral Vault (tUSDC)` (`0x70a8...`): 6-decimal testnet dollar standard.
  * `Round Escrow` (`0x4b5c...`): per-round on-chain settlement; `Operator EOA` (`0xdd68...`) relays stakes and the final payout.

## Setup

```bash
npm install
cp .env.example .env   # MONGODB_URI + OPERATOR_PRIVATE_KEY (STT-funded, testnet)
npm run dev            # http://localhost:3100
npm test               # unit + integration suite
npm run build          # production build
```

Get testnet tUSDC + STT from the Somnia dev group faucet: https://t.me/+XHq0F0JXMyhmMzM0

## Repository

- `src/app/api/**` — server-authoritative game routes
- `src/game/**` — client hook (useGameState) + escrow/ghost integrations
- `src/lib/ec/**` — Event-Contract config, arena discovery, escrow clients, executor, payout
- `src/db/**` — Mongoose models (Match, PlayerStats)
- `tests/**` — Vitest: game loop (client), predict / resolution / API, executor, matchmaking

MIT.
