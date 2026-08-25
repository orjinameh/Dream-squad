# DreamSquad

Social co-op prediction market platform. Users pool capital into synchronized "Syndicates" via invite links, and a backend worker executes queued spot-market trades on DreamDEX using operator delegation.

## Architecture

```
Browser (wagmi) ──────────────────────────────────────────────────────
  /create  ── POST /api/syndicates/create ──> Batch { OPEN, timer }
  /squad/* ── POST /api/syndicates/join   ──> Trade { PENDING }
  /squad/* ── GET  /api/syndicates/:id    ──> Receipts + state

MongoDB ──────────────────────────────────────────────────────────────
  Batch  { status: OPEN | PROCESSING | EXECUTED | FAILED, expiresAt }
  Trade  { batchId, userAddress, amount, status, txHash }
  compound unique index: batchId + userAddress (one intent per user)

Worker (src/worker/run.ts) ──────────────────────────────────────────
  pollEvery: 1.5s
  claimNextBatch(): findOneAndUpdate OPEN -> PROCESSING
  executeBatch():   sequential IOC orders via operator
  per-trade try/catch: isolate failures, normalize known reverts

On-chain (Somnia Shannon Testnet) ───────────────────────────────────
  0x15C7...  OperatorRegistry   setOperatorApprovalForPool()
  0x259f...  SpotPool (SOMI)    placeOrderFor() [operator-delegated]
```

### Key Design Decisions

- **Spot-native syndicates** (not event contracts). Event-contract pools gate operators via `OnlyApprovedContracts()`. Spot pools use the registry's `isOperatorAuthorized` selector gate -- fully compatible with EOA operator delegation.
- **No custody.** Users approve operator once via registry. The operator calls `placeOrderFor` on their behalf. Tokens stay in user vaults.
- **IOC crossing orders.** BUY sets price=10x quote decimals (crosses all asks), SELL sets price=0.001x (crosses all bids). Immediate-or-cancel unfilled remainder returns to vault.
- **One intent per user per batch.** Enforced by compound unique index on (batchId, userAddress).
- **Self-execute fallback.** If operator fails (gas depletion, pool mismatch), users can sign `placeOrderFor` directly from their own wallet.

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 15 (App Router), wagmi v2, @tanstack/react-query |
| API | Next.js Route Handlers, Zod validation |
| Database | Mongoose 8 (MongoDB) |
| On-chain | Viem v2 (Somnia Shannon Testnet) |
| Testing | Vitest, mongodb-memory-server |

## Setup

### Prerequisites

- Node.js >= 18
- MongoDB (local or Atlas)
- Private keys with STT gas on Shannon testnet

### Install

```bash
npm install
```

### Environment

Copy `.env.example` to `.env` and fill:

```bash
MONGODB_URI=mongodb://localhost:27017
MONGODB_DB=dreamsquad
SOMNIA_RPC_URL=https://dream-rpc.somnia.network
OPERATOR_PRIVATE_KEY=0x...   # operator key with STT gas
```

### Run

```bash
# Development
npm run dev          # Next.js on :3000
npm run worker       # executor worker

# Build
npm run build
npm start            # production Next.js
npm run worker       # executor worker
```

### Test

```bash
npm test             # all unit + integration tests
```

### E2E (testnet)

```bash
# Spins up in-memory MongoDB, exercises full pipeline against Shannon
OPERATOR_PRIVATE_KEY=0x... npx tsx scripts/e2e-testnet.ts
```

## Project Structure

```
src/
  app/
    layout.tsx              # dark theme, nav, wallet
    providers.tsx           # wagmi + react-query
    create/page.tsx         # creator flow
    squad/[id]/page.tsx     # invite + lobby + receipt
    api/syndicates/
      create/route.ts       # POST create batch
      join/route.ts         # POST join batch
      [id]/route.ts         # GET batch status + receipts
      check-delegation/route.ts  # read isOperatorAuthorized
      tx-status/route.ts    # read tx receipt
  components/
    WalletButton.tsx        # connect / disconnect
    CountdownTimer.tsx      # live-ticking countdown
  lib/
    config.ts               # chain, ABI, operator address, crossing prices
    markets.ts              # market configs (SOMI, WETH, WBTC)
    operator.ts             # wallet clients, executeTradeOnChain
    validation.ts           # zod schemas
    wagmi.ts                # wagmi config
    worker.ts               # batch claiming + sequential execution
  worker/
    run.ts                  # worker entry point
scripts/
  e2e-testnet.ts            # full E2E verification script
tests/
  api.test.ts               # API integration tests
  executor.test.ts          # executor integration tests
```

## How It Works

1. **Creator** connects wallet, picks market/direction/stake, approves operator delegation (one-time per pool).
2. **Invite link** generated with `squad-<base>-<random>` slug. Share on X or anywhere.
3. **Joiners** connect wallet, approve delegation, pledge amount. All intents stored atomically.
4. **Timer expires.** Worker claims batch (atomic `findOneAndUpdate`), executes sequential IOC orders via operator delegation.
5. **Receipt.** UI polls for status, shows green checkmarks or red failures with on-chain tx links.
6. **Fallback.** If operator fails, "Self-Execute Order" button lets users sign `placeOrderFor` directly from their wallet.

## On-Chain Details (Shannon Testnet)

| Contract | Address |
|----------|---------|
| OperatorRegistry | `0x15C7e8CE38F021c5b45d098AaD788f63090bF20A` |
| SOMI:USDso SpotPool | `0x259fD6559214dd5aD3752322426eA9F9fABEFff4` |
| Operator EOA | `0xdd68998C099f7570E59019ae35469E5603cEDA11` |

## License

MIT
