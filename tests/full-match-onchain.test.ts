import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createPublicClient, createWalletClient, http, parseAbi, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { POST as createRoute } from "@/app/api/matches/create/route";
import { POST as predictRoute } from "@/app/api/matches/predict/route";
import { POST as fundGhostRoute } from "@/app/api/matches/ghost/fund/route";
import { Match } from "@/db/models/Match";
import { EcPosition } from "@/db/models/EcPosition";
import { normalizeAddress } from "@/lib/addresses";
import { matchKey } from "@/lib/ec/matchKey";
import {
  EC_CHAIN, EC_RPC_URL, EC_ADDRESSES, ESCROW_ADMIN, ROUND_ESCROW_ADDRESS,
  EC_COLLATERAL_DECIMALS,
} from "@/lib/ec/config";
import { DREAMDUEL_ROUND_ESCROW_ABI } from "@/lib/ec/escrowAbi";
import { findArenaFloor, readArenaPrice } from "@/lib/ec/executor";

// This test spends REAL testnet gas on each run and drives the REAL on-chain
// money path (fund ghost via relay -> per-round stakeRound -> on-chain settle).
// It only runs when RUN_ONCHAIN=1.
const ENABLED = process.env.RUN_ONCHAIN === "1";

let mongo: MongoMemoryServer;

const TUSDC: `0x${string}` = (EC_ADDRESSES.testUsdc ?? EC_ADDRESSES.collateral)!;

const TUSDC_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function faucet(uint256)",
  "function approve(address,uint256) returns (bool)",
]);

// Deterministic, operator-controlled test player so we never mint to a random
// wallet. Funded on demand from the operator key (native gas) + tUSDC faucet.
const TEST_PK: `0x${string}` = process.env.TEST_PLAYER_PK as `0x${string}` ?? (
  operate => operate)(("0x" + "11".repeat(32)));
const player = privateKeyToAccount(TEST_PK);
const PLAYER = player.address;

const TOTAL_ROUNDS = 7;
const AMOUNT_PER_ROUND = 1; // 1 tUSDC per round
const TOTAL_STAKE_RAW = parseUnits(String(AMOUNT_PER_ROUND * TOTAL_ROUNDS), EC_COLLATERAL_DECIMALS);
const MAX_BURN_PER_ROUND = parseUnits(String(AMOUNT_PER_ROUND + 5), EC_COLLATERAL_DECIMALS); // stake + slack gas

function jsonPost(url: string, body: unknown): Request {
  return new Request(`http://test${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function seedActivePosition(): Promise<void> {
  await EcPosition.create({
    address: normalizeAddress(PLAYER).toLowerCase(),
    direction: "UP",
    market: "BTC",
    amount: AMOUNT_PER_ROUND * TOTAL_ROUNDS,
    status: "ACTIVE",
    windowId: `onchain-${Date.now()}`,
  });
}

async function ensurePlayerFunded(): Promise<void> {
  const pc = createPublicClient({ chain: EC_CHAIN, transport: http(EC_RPC_URL) });
  // 1) native STT for gas (operator relays it). Somnia gas price is non-trivial
  //    (~6 gwei) and tUSDC/approve/stake txs run hot (1-3M gas), so send a proper
  //    budget, not a token-parked 0.003.
  const needStt = BigInt("300000000000000000"); // 0.3 STT
  const stt = await pc.getBalance({ address: player.address });
  if (stt < needStt) {
    const op = privateKeyToAccount(process.env.OPERATOR_PRIVATE_KEY as `0x${string}`);
    const opWc = createWalletClient({ account: op, chain: EC_CHAIN, transport: http(EC_RPC_URL) });
    const h = await opWc.sendTransaction({ to: player.address, value: needStt * 3n });
    await pc.waitForTransactionReceipt({ hash: h });
  }
  // 2) tUSDC via faucet (public) if needed
  const t = await pc.readContract({ address: TUSDC, abi: TUSDC_ABI, functionName: "balanceOf", args: [player.address] });
  if (t < TOTAL_STAKE_RAW * 2n) {
    const wc = createWalletClient({ account: player, chain: EC_CHAIN, transport: http(EC_RPC_URL) });
    const h = await wc.writeContract({
      abi: TUSDC_ABI, address: TUSDC, functionName: "faucet", args: [parseUnits("500", EC_COLLATERAL_DECIMALS)],
      gas: 3_500_000n,
    });
    await pc.waitForTransactionReceipt({ hash: h });
  }
  // 3) approve OPERATOR to relay the transferFrom (single lobby popup equivalent)
  const wc = createWalletClient({ account: player, chain: EC_CHAIN, transport: http(EC_RPC_URL) });
  const allowAbi = parseAbi(["function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
  const cur = await pc.readContract({ address: TUSDC, abi: allowAbi, functionName: "allowance", args: [player.address, ESCROW_ADMIN] });
  if (cur < TOTAL_STAKE_RAW) {
    const h = await wc.writeContract({ abi: allowAbi, address: TUSDC, functionName: "approve", args: [ESCROW_ADMIN, TOTAL_STAKE_RAW * 2n], gas: 3_500_000n });
    await pc.waitForTransactionReceipt({ hash: h });
  }
}

describe("FULL ON-CHAIN bot match (fund relay -> stakeRound -> settle)", () => {
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongo.getUri();
    await mongoose.connect(mongo.getUri());
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  it.runIf(ENABLED)("stakes every round on-chain and settles to a real outcome", async () => {
    await Match.deleteMany({ playerAddress: normalizeAddress(PLAYER).toLowerCase() });
    await EcPosition.deleteMany({ address: normalizeAddress(PLAYER).toLowerCase() });

    await ensurePlayerFunded();
    await seedActivePosition();

    const createRes = await createRoute(jsonPost("/api/matches/create", {
      playerAddress: PLAYER, playerChar: "dreamer", rivalName: "ORACLE", rivalChar: "titan",
      mode: "quick", totalRounds: TOTAL_ROUNDS,
    }));
    expect(createRes.status).toBe(201);
    const { matchId } = await createRes.json();

    // Ghost key (random, like the real ephemeral browser wallet for this match).
    const ghostPk = ("0x" + Array.from({ length: 32 }, (_, i) => ((i * 17) % 256).toString(16).padStart(2, "0")).join("")) as `0x${string}`;
    const ghost = privateKeyToAccount(ghostPk);
    const pc = createPublicClient({ chain: EC_CHAIN, transport: http(EC_RPC_URL) });
    const ghostWc = createWalletClient({ account: ghost, chain: EC_CHAIN, transport: http(EC_RPC_URL) });

    // 1) FUND THE GHOST via the real relay (operator transferFrom player->ghost)
    const fundRes = await fundGhostRoute(jsonPost("/api/matches/ghost/fund", {
      matchId, playerAddress: PLAYER, ghostAddress: ghost.address,
      totalStakeRaw: TOTAL_STAKE_RAW.toString(),
    }) as unknown as Parameters<typeof fundGhostRoute>[0]);
    expect(fundRes.status).toBe(200);
    const fundBody = await fundRes.json();
    expect(fundBody.ok).toBe(true);
    const ghostBal = await pc.readContract({ address: TUSDC, abi: TUSDC_ABI, functionName: "balanceOf", args: [ghost.address] });
    expect(ghostBal).toBeGreaterThanOrEqual(TOTAL_STAKE_RAW);

    // 2) Ghost approves the round escrow so it can lock funds per round.
    const escrowAllowAbi = parseAbi(["function approve(address,uint256) returns (bool)"]);
    const ap = await ghostWc.writeContract({ abi: escrowAllowAbi, address: TUSDC, functionName: "approve", args: [ROUND_ESCROW_ADDRESS, MAX_BURN_PER_ROUND * BigInt(TOTAL_ROUNDS)], gas: 3_500_000n });
    await pc.waitForTransactionReceipt({ hash: ap });

    // 3) Play all 7 rounds: STAKE on-chain, then resolve via the real predict route
    //    (which settles the round on-chain through settleRoundOnEscrowGuarded).
    let final: any;
    const stakeTxs: string[] = [];
    for (let round = 1; round <= TOTAL_ROUNDS; round++) {
      // entry price = live EC YES mid for BTC arena (the real reference).
      const arena = (await findArenaFloor("BTC", 0)) ?? (await findArenaFloor("BTC", 30));
      expect(arena, `no live BTC arena for round ${round}`).toBeTruthy();
      const quote = await readArenaPrice(arena!);
      const entryPrice = quote.yesPrice !== null ? parseUnits(quote.yesPrice.toFixed(6), EC_COLLATERAL_DECIMALS) : parseUnits("1", EC_COLLATERAL_DECIMALS);
      const amt = parseUnits(String(AMOUNT_PER_ROUND), EC_COLLATERAL_DECIMALS);

      const sh = await ghostWc.writeContract({
        address: ROUND_ESCROW_ADDRESS,
        abi: DREAMDUEL_ROUND_ESCROW_ABI,
        functionName: "stakeRound",
        args: [matchKey(matchId, PLAYER), BigInt(round), amt, entryPrice],
        gas: 3_000_000n,
      });
      await pc.waitForTransactionReceipt({ hash: sh });
      stakeTxs.push(sh);

      const res = await predictRoute(jsonPost("/api/matches/predict", {
        matchId, playerAddress: PLAYER, prediction: "UP",
      }));
      expect(res.status).toBe(200);
      final = await res.json();
      await new Promise((r) => setTimeout(r, 400));
    }

    // 4) Match completed with a real winner.
    expect(final.winner).toBeDefined();
    expect((final.rounds ?? []).length).toBe(TOTAL_ROUNDS);
    expect(final.status).toBe("COMPLETED");

    // 5) On-chain settlement: every round's lock must be settled (stake existed
    //    and settleRound ran). Post a final predict to flush any pending settle.
    await predictRoute(jsonPost("/api/matches/predict", { matchId, playerAddress: PLAYER }));
    for (let round = 1; round <= TOTAL_ROUNDS; round++) {
      const lock = (await pc.readContract({
        address: ROUND_ESCROW_ADDRESS,
        abi: DREAMDUEL_ROUND_ESCROW_ABI,
        functionName: "roundLock",
        args: [matchKey(matchId, PLAYER), BigInt(round)],
      })) as [`0x${string}`, bigint, bigint, number, boolean];
      const [owner, amount, , , settled] = lock;
      expect(owner.toLowerCase()).toBe(ghost.address.toLowerCase());
      expect(amount).toBeGreaterThan(0n);
      expect(settled).toBe(true); // on-chain settleRound confirmed
    }

    // 6) The on-chain result is a real outcome (not a degenerate all-FLAT 0-0).
    const actuals: string[] = (final.rounds ?? []).map((r: any) => r.actual);
    console.log(`ONCHAIN actuals=${JSON.stringify(actuals)} winner=${final.winner} stakeTxs=${stakeTxs.length}`);
  }, 600_000);
});
