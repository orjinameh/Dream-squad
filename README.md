# ⚔️ DreamDuel
### *The 20-Second Web3 Combat Arcade Powered by dreamDEX Event Contracts*

**DreamDuel** transforms high-velocity crypto event speculation into a fast-paced, 1v1 retro fighting game. Built natively on the high-throughput **Somnia Network (Chain 50312)** for the **Somnia × dreamDEX Event Contracts Hackathon**, two gladiators (Player vs Player or Player vs Bot) fight 7 locked binary rounds—every round's UP/DOWN is picked fresh in its commit phase, judged directly against the live dreamDEX order book, with immersive combat animations, win-streaks, and knockouts deciding the duel.

By engineering a **Hybrid State Engine with EOA Operator Delegation**, DreamDuel compresses complex, intimidating decentralized terminal layouts into a frictionless gameplay loop—allowing casual players to trade real on-chain prediction tokens entirely through raw gaming inputs with **zero wallet popups mid-match** (one funding approval up front, then 7 confirmed rounds).

---

## 🔄 System Architecture & Data Flow

```text
Browser Flow (wagmi + RainbowKit)
  L Lobby: MARKET -> POSITION/approve -> MATCH_TYPE (Public Queue / Private Code)
  L Commit Phase: COMMIT (10s, fresh pick) -> stake + funding confirmed
  L Battle Phase: ACTIVE (10s locked trade) -> resolve -> DB paper credit
  L Cycle: ... repeat x7 rounds ... -> KO / match over
  L Settlement: ONE final tUSDC payout (draws back + net winnings)

Next.js Route Handlers (Serverless Authoritative)
  POST /api/matches/create|predict       Round lifecycle state machine (COMMIT/ACTIVE/EXECUTING)
  GET  /api/matches/state|history|detail State rehydration + round contract delta logs
  POST /api/matchmaking/room             Create unique private alphanumeric duel invite codes
  POST /api/matchmaking/join             Validate and join private custom rooms via code
  POST /api/matchmaking/*                Public PvP queue matchmaking (join/leave/status)
  POST /api/position                     Funding approval + position record (size the match pot)
  GET  /api/matches/ec-tape              Live YES probability tape ($0.01 to $0.99) for active arena
  GET  /api/matches/ec-position          Live YES-mid vs entry anchor + direction chip
  GET  /api/leaderboard                  Global LP/Elo mapping pipeline
  GET  /api/cron/sweep                   Settlement sweep (worker also runs it every ~15s)
```

### 💸 The Frictionless Money Model (Every Unit Accounted)
* **Approve once:** The `POSITION` screen collects a single operator approval sized `amount × rounds`. Nothing leaves the wallet there. 
* **Draw per confirmed round:** Each `COMMIT` gate executes a `transferFrom` for exactly that round's actual fill cost (partial IOC fills draw partial cost) and awaits the receipt. A finished match cleanly exhausts its approval—replay needs a fresh one.
* **Paper ledger per round:** Wins net `qty − cost`, losses cost actual fill cost, and an honest `FLAT` is a clean push (0). Displayed net always equals real wallet delta.
* **One final payout:** Drawn stakes back + paper net are sent straight to the player's wallet. The background worker sweeps and redeems the operator's venue shares off-line via `settleRoundStakes()`.

---

## ⏱️ The 20-Second Round Lifecycle

Every round enforces a rigid, server-authoritative 20-second mechanical split that matches true binary options trading parameters. Time is lenient everywhere **except** the 10s battle—rounds advance on confirmations, never on expired clocks (no skips):

### 1. Phase 1: COMMIT & Stake (0s – 10s) `[The Single Blocking Gate]`
A 10-second countdown prompts a **fresh pick every round**—Attack (YES order) or Defend (NO order). No pick carries over; an idle round locks the `UP` default rather than a stale call. The background operator wallet places the order on the dreamDEX router via the markets SDK trader, then draws that round's fill cost from your funding approval. 

The serverless handler blocks the countdown loop until *both* receipts (stake + funding) are confirmed, preventing multi-round nonce congestion or double-staking. No receipt means no `ACTIVE` state (client holds and retries with a `502`), and the 10s battle clock is pinned directly to confirmation time. Creating or joining a match re-verifies the on-chain approval covers the full pot (`402` if short).

### 2. Phase 2: BATTLE & Locked Trade (10s – 20s) `[Zero UI Popups]`
Inputs are entirely frozen (`LOCKED — TRADE RUNNING`). Characters run high-intensity clashing and charging animation loops while the embedded chart streams the **live EC YES-probability tape**—the exact series the round is judged on, never spot. The trade position is locked on-chain, tracking live probability shifts on the book.

### 3. Phase 3: RESOLUTION & Paper Credit (At Second 20)
The countdown hits zero and triggers a temporary calculation freeze overlay, then resolution retries until the server confirms (never a fabricated or skipped round). The round is judged on the **EC order book itself** (Second-20 YES-mid vs Second-10 YES-mid). A book that sat literally untouched across the round is an honest `FLAT` draw (stake back, no damage). 

**The Optimization:** To completely bypass slow, erratic block latency mid-match, the engine logs wins and losses instantly as an **off-chain paper credit** inside the MongoDB match document (`match.playerBalance`), releasing hit animations and dropping health bars at lightning speed.

### 4. Phase 4: GAME OVER & Final Payout
Upon round 7 completion or a total knockout, the system pays **drawn stakes back + paper net** directly from the MongoDB ledger. The operator wallet fires **exactly one real on-chain tUSDC transfer** to the player's primary wallet (recipient-validated, idempotent). An independent background worker sweeps and redeems the operator's contract shares off-line via `settleRoundStakes()`.

---

## 🎯 Judge, Windows & Charts

* **EC-only oracle:** The YES-mid move (exit vs entry) decides every round; protocol `winningOutcome` rules when a window has already settled. No spot fallback—the house settles on this book, so the book judges.
* **5-minute venue windows:** 15-minute fallback when the 5m series gaps to prevent game outages. Zero-strike placeholder windows are never touched.
* **One price reality:** All charts render the CLOB YES-probability tape ($0.01–$0.99, real fills + live top-of-book edge + dashed Second-10 entry line + volume), built with Recharts (watermark-free SVG). The question, chart, stake window, and resolution all follow a single asset truth.
* **Combat & Custom Interactions:** Base 15 damage + streak bonuses (critical at 3+), 100 HP, KO ends it early. Both-correct clashes pay the trade but deal no damage. Unlike other staking dashboards, DreamDuel features full combat graphics and a **Private Room Invite Code engine** for custom peer-to-peer matches handled serverless via MongoDB atomic handshakes.

---

## 🛠️ The Production Stack

* **Frontend:** Next.js 15 (App Router), React 19, `wagmi v2` + RainbowKit, Recharts.
* **Database & Ledger:** MongoDB via Mongoose 8. Atomic COMMIT➔ACTIVE claims, per-round staking locks, and idempotency keys (`processedMatches`, per-round payout records) structurally guarantee exactly one locked position, one funding draw, and one final payout per match.
* **On-Chain Infrastructure (Somnia Shannon Testnet - 50312):**
  * `OperatorRegistry` (`0x15C7...`): Secures the one-time, non-custodial delegation permission profile.
  * `dreamDEX Router/CLOB` (`0x259f...`): Processes immediate-or-cancel (IOC) contract token purchases crossing the live Event Contract order books.
  * `Collateral Vault (tUSDC)` (`0x70a8...`): 6-decimal testnet dollar standard.
  * `Round Escrow` (`0x4b5c...`): Handles per-round on-chain settlement; `Operator EOA` (`0xdd68...`) relays stakes, draws funding, and fires the final payout.

---

## 💻 Setup & Repository

```bash
npm install
cp .env.example .env   # MONGODB_URI + OPERATOR_PRIVATE_KEY (STT-funded, testnet)
npm run dev            # http://localhost:3100
npm test               # unit + integration suite
npm run build          # production build
```

Get testnet tUSDC + STT from the Somnia dev group faucet: https://t.me/+XHq0F0JXMyhmMzM0

* `src/app/api/**` — server-authoritative game routes (`matches/*`, `matchmaking/*`, `position`, `ec-tape`, `ec-position`, `stakes`, `leaderboard`, `cron/sweep`)
* `src/game/**` — client hook (`useGameState`) + escrow integrations + `ProbabilityChart`
* `src/lib/ec/**` — Event-Contract config, arena discovery, escrow/staker/funding/payout clients, executor (judge), oracle
* `src/db/**` — Mongoose models (`Match`, `PlayerStats`, `EcPosition`, `MatchQueue`, `MatchRoom`)
* `tests/**` — Vitest: game loop (client), predict / resolution / API, executor, matchmaking, tape, buckets, window cadence, JSX-unicode guard

---
MIT License. 
