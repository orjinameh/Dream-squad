import { connectToDatabase } from "@/db/connect";
import { EcPosition } from "@/db/models/EcPosition";
import { createPublicClient, http, type Hash } from "viem";
import { findArenaFloor, readArenaPrice, readArenaSettlement } from "./executor";
import { positionWindowId } from "./matchId";
import { positionInfo, settleWindowOnchain, collectLostOnchain, positionOpen } from "./escrow";
import { EC_CHAIN, EC_RPC_URL, ESCROW_ADDRESS, ESCROW_LEGACY_BY_AGE } from "./config";

/** Entry-price scale shared with the v3 escrow (1e6 = $1.00). */
export const ENTRY_PRICE_SCALE = 1_000_000n;

/**
 * Find the escrow contract that actually holds a position's stake. Docs created
 * after a redeploy carry their exact `escrowAddress`; for legacy docs (no field)
 * we probe the deployment history for the contract whose slot is open/settled so
 * a settled WON stake on an old escrow stays reachable for withdraw.
 */
export async function resolvePositionEscrow(
  windowId: string,
  pos: { escrowAddress?: string },
): Promise<`0x${string}`> {
  const seen = new Set<string>();
  const candidates = [pos.escrowAddress, ESCROW_ADDRESS, ...ESCROW_LEGACY_BY_AGE]
    .filter((a): a is string => !!a && !seen.has(a.toLowerCase()) && (seen.add(a.toLowerCase()), true));
  for (const addr of candidates) {
    try {
      const p = await positionInfo(windowId as `0x${string}`, addr as `0x${string}`);
      if (p.open || p.settled) return addr as `0x${string}`;
    } catch {
      /* try the next deployment */
    }
  }
  return candidates[0] as `0x${string}` ?? ESCROW_ADDRESS;
}

/**
 * The player's side entry price (0..1) for a direction: UP buys the YES token,
 * DOWN buys the NO token (no = 1 - yes on the DEX). Scaled to 1e6 for the
 * escrow's fixed $1.00-per-token payout math.
 */
function sideEntryPriceScaled(yesPrice: number, direction: "UP" | "DOWN"): bigint {
  const p = direction === "UP" ? yesPrice : Number((1 - yesPrice).toFixed(6));
  const clamped = Math.min(Math.max(p, 0.01), 1);
  return BigInt(Math.round(clamped * 1_000_000));
}

export interface OpenPositionInput {
  address: string;
  direction: "UP" | "DOWN";
  market: "BTC" | "ETH";
  amount: number;
}

/**
 * Find a wallet's currently-active EC position, if any.
 */
export async function findActivePosition(address: string) {
  await connectToDatabase();
  const addr = address.toLowerCase();
  return EcPosition.findOne({ address: addr, status: "ACTIVE" }).sort({ createdAt: -1 }).lean();
}

/**
 * Create an EC position (the 15-minute financial stake). This is app-side
 * bookkeeping — the tUSDC is pulled on-chain by the PLAYER's wallet via
 * `stake(windowId, amount)` in the browser. The windowId is deterministic from
 * (address, direction, market, nonce) so the browser can derive it.
 *
 * Returns the position doc + the windowId it expects the player to stake on.
 */
export async function openPosition(input: OpenPositionInput) {
  await connectToDatabase();
  const addr = input.address.toLowerCase();

  // Per-round model: each position is a plain per-match funding record. There's
  // no single on-chain window to lock the wallet against, so opening (or
  // switching direction for) a new fight just creates a fresh ACTIVE record.
  // Any stale ACTIVE records from the legacy model are cleared so they can't
  // block a new fight.
  await EcPosition.deleteMany({ address: addr, status: "ACTIVE" });

  const now = new Date();
  const windowId = `per-round-${addr}-${now.getTime()}`;

  const doc = await EcPosition.create({
    _id: undefined,
    address: addr,
    direction: input.direction,
    market: input.market,
    amount: input.amount,
    // v4 arena fields are intentionally omitted for per-round mode
    entryPrice: "0",
    escrowAddress: ESCROW_ADDRESS,
    status: "ACTIVE",
    windowId,
    windowOpenAt: now,
    // No windowCloseAt — per-round positions don't expire on a v4 window
    settledOnchain: false,
    matchCount: 0,
    createdAt: now,
  });

  return {
    position: doc.toObject(),
    windowId,
    escrow: ESCROW_ADDRESS,
    entryPrice: 0n,
    windowClose: 0,
  };
}

/**
 * Determine whether an EC position's window won or lost, from the REAL on-chain
 * EC settlement (winningOutcome: 0=YES, 1=NO). A player's UP/DOWN call maps to
 * the binary side:
 *   UP  -> wants the window's YES outcome (price moved up → YES in-the-money)
 *   DOWN-> wants the window's NO outcome
 * Returns null while the window is unresolved or the arena isn't settled.
 */
export async function resolvePositionOutcome(position: {
  direction: "UP" | "DOWN" | string;
  arena?: unknown;
}): Promise<boolean | null> {
  if (!position.arena) return null;
  const arena = position.arena as { pool: `0x${string}` };
  const settlement = await readArenaSettlement(arena as never).catch(() => null);
  if (!settlement || !settlement.isResolved) return null;
  const yesWon = settlement.winningOutcome === 0;
  // UP wins when YES wins; DOWN wins when NO wins.
  return position.direction === "UP" ? yesWon : !yesWon;
}

/**
 * Settle positions whose EC windows have resolved. Calls the REAL on-chain EC
 * result → implements it on-chain via settleWindow + pays/collects.
 * Returns the count of positions newly settled.
 */
export interface ReconcileDebugEntry {
  id: string;
  market: string;
  arena: string | null;
  onchain: string | null;
  outcome: string | null;
  win: boolean | null;
  settledAt: string | null;
  error: string | null;
}

/** Populated by reconcilePositions({debug:true}); read by the reconcile route. */
export const reconcileDebug: ReconcileDebugEntry[] = [];

export async function reconcilePositions(
  { inWindow = true, debug = false, address }: { inWindow?: boolean; debug?: boolean; address?: string } = {},
): Promise<number> {
  await connectToDatabase();
  reconcileDebug.length = 0;
  const query: Record<string, unknown> = {};
  if (address) {
    query["address"] = address.toLowerCase();
    query["status"] = { $in: ["ACTIVE", "SETTLED"] };
  } else {
    query["status"] = "ACTIVE";
  }
  if (inWindow) query["windowCloseAt"] = { $lte: new Date() };

  const nowSec = Math.floor(Date.now() / 1000);
  const active = await EcPosition.find(query).lean();
  let settled = 0;

  for (const pos of active) {
    const entry: ReconcileDebugEntry = {
      id: String(pos._id),
      market: `${(pos as any).market ?? "?"}-${(pos as any).direction ?? "?"}`,
      arena: (pos as any).arena?.symbol ?? null,
      onchain: null,
      outcome: null,
      win: null,
      settledAt: null,
      error: null,
    };
    try {
      if (!pos.windowId) { entry.error = "no windowId"; continue; }
      const escrow = await resolvePositionEscrow(pos.windowId as string, pos);
      const onchain = await positionInfo(pos.windowId as `0x${string}`, escrow).catch(() => null);
      entry.onchain = onchain
        ? `open=${onchain.open} settled=${onchain.settled} won=${Number(onchain.won)} escrow=${escrow}`
        : "null(readFailed)";

      // Already settled on-chain → sync the doc (covers rows marked SETTLED by a
      // relayer whose settle was later confirmed, and clean win/loss states).
      if (onchain?.settled) {
        await EcPosition.updateOne(
          { _id: pos._id },
          {
            status: "SETTLED",
            settledWon: Number(onchain.won) === 1,
            settledAt: new Date(),
            settledOnchain: true,
          },
        );
        settled += 1;
        entry.outcome = "settled-onchain";
        entry.settledAt = new Date().toISOString();
        continue;
      }
      // Not settled on-chain AND window closed → the real settle may not have
      // happened yet (relayer skipped/reverted). Re-drive it below.
      const windowOver = onchain ? nowSec >= Number(onchain.windowClose) : true;
      if (onchain && !windowOver) {
        entry.outcome = `escrow-locked-until-${Number(onchain.windowClose)}`;
        continue; // venue result may already be final; escrow unlock hasn't come
      }
      // A doc that was never funded on-chain (browser stake failed) is a phantom.
      // Only clean ACTIVE phantoms — NEVER delete a SETTLED row from history: a
      // settled position whose on-chain slot now reads empty (legacy escrow/ABI
      // mismatch, mis-resolved deployment, or already-collected) must stay in
      // the player's stake history. Removing it here is why old stakes vanished.
      if (onchain && !onchain.open && pos.status === "ACTIVE") {
        await EcPosition.deleteOne({ _id: pos._id });
        entry.outcome = "phantom-deleted";
        continue;
      }
      // Resolve the real outcome and implement it on-chain.
      const won = await resolvePositionOutcome(pos);
      entry.outcome = won === null ? "readArenaSettlement -> null (not resolved?)" : String(won);
      if (won === null) continue;
      const win = won as boolean;
      const tx = await settleWindowOnchain(pos.windowId as `0x${string}`, win, escrow);
      entry.settledAt = tx as unknown as string;
      // Verify the settle actually mined — a reverted tx must NOT mark the doc
      // SETTLED (that strandles the stake as "done" while on-chain it's locked).
      try {
        const receipt = await waitForReceipt(tx as `0x${string}`);
        if (receipt.status !== "success") {
          entry.error = `settle tx rejected on-chain (status=${receipt.status})`;
          continue;
        }
      } catch (err) {
        entry.error = `settle tx not mined: ${err instanceof Error ? err.message : String(err)}`;
        continue;
      }
      if (!win) {
        await collectLostOnchain(pos.windowId as `0x${string}`, escrow).catch(() => {});
      }
      await EcPosition.updateOne(
        { _id: pos._id },
        {
          status: "SETTLED",
          settledWon: win,
          settledAt: new Date(),
          settledOnchain: true,
        },
      );
      entry.win = win;
      settled += 1;
    } catch (err) {
      console.error(`[position] reconcile failed for ${pos._id}`, err);
      entry.error = err instanceof Error ? `${err.message.slice(0, 200)}` : String(err);
    } finally {
      if (debug) reconcileDebug.push(entry);
    }
  }
  return settled;
}

async function waitForReceipt(hash: `0x${string}`) {
  const pc = createPublicClient({ chain: EC_CHAIN, transport: http(EC_RPC_URL) });
  for (let i = 0; i < 30; i++) {
    try {
      const r = await pc.getTransactionReceipt({ hash });
      if (r) return r;
    } catch {
      /* not mined yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("settle tx did not confirm in time");
}

export class PositionError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
