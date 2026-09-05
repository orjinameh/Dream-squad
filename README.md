# DreamDuel

Retro 1v1 prediction-battle game on **Somnia Shannon testnet (chain 50312)**, built for the Somnia × DreamDEX Event Contracts Hackathon.

Two fighters (player vs player, or player vs bot) pick **UP/DOWN** on a live DreamDEX Event-Contract market each round. Correct calls land combat damage; streaks and knockouts decide the best-of-N duel. Every round **resolves against the real Event-Contract order book** — the live YES probability of BTC/ETH binary markets is the only oracle — and each stake **settles on-chain** through the DreamDuel escrow contracts.

```
fund ──▶ stake position ──▶ fight (UP/DOWN per round) ──▶ round resolves on the real EC order book ──▶ settle on-chain
wallet    approve          commit (5s) + active (10s)      FLAT / UP / DOWN → damage / HP / KO           escrow
```

## What the judge sees

- **Real DreamDEX Event-Contract integration.** The arena floor is discovered live via `@somnia-chain/markets-sdk` (`loadMarkets` + on-chain status gate), and each round's outcome derives from the actual order-book YES-mid over the round's entry→exit window (spread/band aware, with retries). Nothing is a simulated price.
- **Real on-chain settlement.** tUSDC is staked into the DreamDuel round escrow per round; the backend relayer settles each round's stake against the real outcome — win returns the stake, loss forfeits to the house. Wallet-to-wallet PvP settles each player's stake independently.
- **Robust against testnet RPC flakiness.** All chain traffic tiers across three RPC mirrors (thirdweb → dream-rpc → api.infra) with viem `fallback`; wallet approves carry an explicit gas price so a rate-limited `eth_gasPrice` never blocks the popup.
- **Server-authoritative combat.** Damage, streaks, criticals, KO, and match completion are computed server-side from the resolved market move; clients are thin renderers with a freeze-proof local-advance fallback.

## Architecture

```
Browser (wagmi + RainbowKit) ─────────────────────────────────────────────
  └ 1v1 match flow: CHAR_SELECT → MATCH_TYPE → POSITION/approve → COMMIT(5s)
     → ACTIVE(10s, flippable UP↔DOWN) → resolve → next round / KO / result

Next.js Route Handlers (server-authoritative)
  POST /api/matches/create|ready|predict   round machine (COMMIT→ACTIVE→EXECUTING)
  GET  /api/matches/state|history|detail   state + rehydrate
  POST /api/position                       EC position (window stake + entry price)
  POST /api/matches/ghost/fund             bot-match ghost deposit (one approve, then no popups)
  GET  /api/leaderboard                    stats / rank
  POST /api/matchmaking/*                  PvP matchmaking
  GET  /api/health                         liveness

MongoDB (Mongoose)
  Match   { players, round machine, rounds[], priceModel{arena, checkpoints}, escrow refs }
  PlayerStats { wins/losses, streaks, rankPoints (PvP only — bot matches never move rank) }

On-chain (Somnia testnet, 50312)
  ┌─ @somnia-chain/markets-sdk ── arena discovery + order-book oracle
  ├─ Escrow (window positions)       0xd068e4b26357239d3ea0fd960c781fcb2512c5c9
  ├─ Round Escrow (per-round settle) 0x4b5c9d4dec4542a2df02314952cbcc7dae665bdc
  ├─ Admin / ghost relay EOA         0xdd68998C099f7570E59019ae35469E5603cEDA11
  └─ Collateral (tUSDC, 6 dp)        0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E
```

## Key design decisions

- **Event Contracts ARE the oracle.** The DEX's binary markets are the only price source. A round whose YES-mid moved past the (spread-aware) flat band resolves UP/DOWN; otherwise an honest FLAT (no damage). The venue's zero-strike rolling-placeholder windows are deliberately skipped so a stake can never lock forever.
- **Ghost-funded bot matches.** One wallet `approve` funds the whole match; the server relays player→ghost, and the ghost signs every round (no popups). Unused grants auto-revoke after 5 minutes.
- **PvP rounds resolve at the close, never early.** A mid-window flip is stored but the round stays ACTIVE until the deadline — the outcome derives from the full entry→exit move, not the instant the last player tapped.
- **No custody.** Players hold their own tUSDC; the escrow only moves what each round's settled outcome dictates.

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 15 (App Router), React 19, wagmi v2 + RainbowKit |
| API | Next.js Route Handlers, Zod |
| Database | Mongoose 8 (MongoDB) |
| On-chain | viem v2, @somnia-chain/markets-sdk ^0.28.x (Somnia testnet) |
| Testing | Vitest, mongodb-memory-server |

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
- `src/lib/ec/**` — Event-Contract config, arena discovery, escrow clients, executor
- `src/db/**` — Mongoose models (Match, PlayerStats)
- `tests/**` — Vitest: game loop (client), predict / resolution / API, executor, matchmaking

MIT.