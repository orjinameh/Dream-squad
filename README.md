# ⚔️ DreamDuel
### *The 20-Second Web3 Combat Arcade Powered by dreamDEX Event Contracts*

DreamDuel turns high-velocity crypto event-speculation into a fast-paced, 1v1 retro fighting game. Built natively on the high-throughput **Somnia Network (Chain 50312)** for the **Somnia × dreamDEX Event Contracts Hackathon**, two gladiators (Player vs Player or Player vs Bot) fight 7 locked binary rounds — every round's UP/DOWN picked fresh in its commit, each judged on the live dreamDEX order book, with damage, streaks, and knockouts deciding the duel.

By engineering a **Hybrid State Engine with EOA Operator Delegation**, DreamDuel compresses complex, intimidating terminal grids into a frictionless gameplay loop — allowing casual players to trade real on-chain prediction tokens entirely through raw gaming inputs with **zero wallet popups mid-match** (one funding approval up front, then 7 confirmed rounds).

---

## 🔄 System Architecture & Data Flow

```
Browser (wagmi + RainbowKit) ─────────────────────────────────────────────
  └ 1v1 match flow: MARKET → POSITION/approve → MATCH_TYPE → COMMIT(10s, fresh pick)
     → stake + funding confirmed → ACTIVE(10s locked trade) → resolve → DB paper credit
     → … ×7 rounds … → KO / result → ONE final tUSDC payout (draws back + net)

Next.js Route Handlers (server-authoritative)
  POST /api/matches/create|predict       Round lifecycle state machine (COMMIT→ACTIVE→EXECUTING)
  GET  /api/matches/state|history|detail State rehydration + round-by-round contract delta log
  POST /api/matchmaking/*                PvP matchmaking (join/leave/status)
  POST /api/position                     Funding approval + position record (size the match pot)
  GET  /api/matches/ec-tape             Live YES-probability tape ($0.01–$0.99) for the arena in play
  GET  /api/matches/ec-position         Live YES-mid vs entry anchor + direction chip
  GET  /api/leaderboard                  Global LP/Elo mapping pipeline
  GET  /api/cron/sweep                   Settlement sweep (worker also runs it every ~15s)
```

**Money model (every unit accounted):**
- **Approve once:** the POSITION screen collects a single operator approval sized `amount × rounds`. Nothing leaves the wallet there.
- **Draw per confirmed round:** each COMMIT gate `transferFrom`s exactly that round's *actual fill cost* (partial IOC fills draw partial cost) and awaits the receipt. A finished match exhausts its approval — replay needs a fresh one.
- **Paper ledger per round:** wins net `qty − cost`, losses cost actual fill cost, FLAT is a push (0). Displayed net always equals real wallet delta.
- **One final payout:** drawn stakes back + paper net, straight to the player's wallet. The worker recoups the operator's venue shares off-line via `settleRoundStakes()`.

---

## ⏱️ The 20-Second Round Lifecycle

Every round enforces a rigid, server-authoritative 20-second mechanical split that matches true binary-options trading parameters. Time is lenient everywhere **except** the 10s battle — rounds advance on confirmations, never on expired clocks (no skips):

1. **Phase 1: COMMIT & Stake (0s – 10s) `[The Single Blocking Gate]`**
   * A 10-second countdown prompts a **fresh pick every round** — Attack (YES order) or Defend (NO order). No pick carries over; an idle round locks the `UP` default rather than a stale call.
   * The background operator wallet places the order on the dreamDEX router via the markets SDK trader, then draws that round's fill cost from your funding approval.
   * **The Hard Gate:** the handler awaits *both* receipts (stake + funding) before the battle may open — enforced by a per-round staking lock, so retries during slow confirmations can never double-stake or double-draw. No receipt → no ACTIVE (client holds and retries with `502`), and the 10s battle clock is pinned to confirmation time.
   * **Fund check at match open:** creating or joining a match re-verifies the on-chain approval covers the full pot (`402` if short).

2. **Phase 2: BATTLE & Locked Trade (10s – 20s) `[Zero UI Popups]`**
   * Inputs are entirely frozen (`LOCKED — TRADE RUNNING`). Characters run clashing/charging animation loops while the embedded chart streams the **live EC YES-probability tape** — the exact series the round is judged on, never spot.
   * The trade position is locked on-chain, tracking the live implied-probability shifts of the player's YES/NO shares on the dreamDEX order book.

3. **Phase 3: RESOLUTION & Paper Credit (At Second 20)**
   * The countdown hits zero and triggers a temporary calculation freeze overlay, then resolution retries until the server confirms (never a fabricated round, never a skipped one).
   * The round is judged on the **EC order book itself** (Second-20 YES-mid vs Second-10 YES-mid): any genuine tick movement decides it, exactly the book the house settles on. A book that sat literally untouched across the round is an honest FLAT draw (stake back, no damage).
   * **The Optimization:** to completely bypass slow, erratic block latency mid-match, the engine logs wins/losses instantly as an **off-chain paper credit** inside the MongoDB match document (`match.playerBalance`), releasing the hit animations and updating health bars at lightning speed.

4. **Phase 4: GAME OVER & Final Payout**
   * Upon round 7 completion or a total knockout, the system pays **drawn stakes back + paper net** from the MongoDB ledger.
   * The operator wallet fires **exactly one real on-chain tUSDC transfer** to the player's primary wallet (recipient-validated, idempotent). An independent background worker sweeps and redeems the operator's contract shares off-line via `settleRoundStakes()`.

---

## 🎯 Judge, Windows & Charts

* **EC-only oracle.** The YES-mid move (exit vs entry) with an epsilon band decides every round; protocol `winningOutcome` rules when a window has already settled. No spot fallback — the house settles on this book, so the book judges.
* **5-minute venue windows** (15-minute fallback when the 5m series gaps — a strict filter would outage the game). Zero-strike placeholder windows are never touched.
* **One price reality.** All charts render the CLOB YES-probability tape ($0.01–$0.99, real fills + live top-of-book edge + dashed Second-10 entry line + volume), built with Recharts. The question, chart, stake window, and resolution all follow a single asset truth (market pick → funded position → match).
* **Combat.** Base 15 damage + streak bonuses (critical at 3+), 100 HP, KO ends it early; both-correct clashes pay the trade but deal no damage; scores count correct calls.

## 🛠️ The Production Stack

* **Frontend:** Next.js 15 (App Router), React 19, `wagmi v2` + RainbowKit, Recharts (watermark-free SVG).
* **Database & Ledger:** MongoDB via Mongoose 8. Atomic COMMIT→ACTIVE claims, per-round staking locks, idempotency keys (`processedMatches`, per-round payout records) structurally guarantee exactly one locked position, one funding draw, and one final payout per match.
* **On-Chain Infrastructure:** deployed natively on **Somnia Shannon Testnet (50312)**:
  * `OperatorRegistry` (`0x15C7...`): secures the one-time, non-custodial delegation permission profile.
  * `dreamDEX Router/CLOB` (`0x259f...`): processes immediate-or-cancel (IOC) contract token purchases crossing the live Event Contract order books.
  * `Collateral Vault (tUSDC)` (`0x70a8...`): 6-decimal testnet dollar standard.
  * `Round Escrow` (`0x4b5c...`): per-round on-chain settlement; `Operator EOA` (`0xdd68...`) relays stakes, draws funding, and fires the final payout.

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

- `src/app/api/**` — server-authoritative game routes (`matches/*`, `matchmaking/*`, `position`, `ec-tape`, `ec-position`, `stakes`, `leaderboard`, `cron/sweep`)
- `src/game/**` — client hook (useGameState) + escrow integrations + `ProbabilityChart`
- `src/lib/ec/**` — Event-Contract config, arena discovery, escrow/staker/funding/payout clients, executor (judge), oracle
- `src/db/**` — Mongoose models (Match, PlayerStats, EcPosition, MatchQueue)
- `tests/**` — Vitest: game loop (client), predict / resolution / API, executor, matchmaking, tape, buckets, window cadence, JSX-unicode guard

MIT.
