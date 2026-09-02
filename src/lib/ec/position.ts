import { connectToDatabase } from "@/db/connect";
import { EcPosition } from "@/db/models/EcPosition";
import { findArenaFloor, readArenaPrice, readArenaSettlement } from "./executor";
import { positionWindowId } from "./matchId";
import { positionInfo, settleWindowOnchain, collectLostOnchain, positionOpen } from "./escrow";
import { ESCROW_ADDRESS, ESCROW_LEGACY_BY_AGE } from "./config";

const POSITION_WINDOW_MS = 15 * 60 * 1000; // ~15 minute DreamDEX window

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

  // Mirror on-chain truth: a DB doc is only a REAL active position if tUSDC is
  // actually staked/open on-chain for its windowId (`position(windowId)`).
  // A phantom (browser stake never landed) must NOT lock the wallet — clear it
  // so the player can simply stake again.
  const existing = await EcPosition.find({ address: addr, status: "ACTIVE" }).lean();
  for (const pos of existing) {
    if (!pos.windowId) continue;
    // On a read error, assume it's a real stake (never clear a possibly-funded
    // position) — safe direction.
    const escrow = await resolvePositionEscrow(pos.windowId as string, pos);
    const open = await positionOpen(pos.windowId as `0x${string}`, escrow).catch(() => true);
    if (open) {
      throw new PositionError(409, "you already have an active EC position. Settle it or switch direction by opening a new one.");
    }
  }
  // We only reach here if none of the wallet's ACTIVE docs are funded on-chain,
  // so they're all phantoms — remove them so they can't block a fresh stake.
  await EcPosition.deleteMany({ address: addr, status: "ACTIVE" });

  // Pin the live EC arena floor (the 15-min window the position rides).
  const arena = await findArenaFloor(input.market, 30);
  if (!arena) {
    throw new PositionError(503, "no live Event Contract window right now — try again in a moment");
  }
  const openPrice = await readArenaPrice(arena).then((q) => (q.yesPrice && q.yesPrice > 0 ? q.yesPrice : 0)).catch(() => 0);
  const entryPrice = openPrice > 0 ? sideEntryPriceScaled(openPrice, input.direction) : ENTRY_PRICE_SCALE / 2n;

  const now = new Date();
  const windowOpen = Math.floor(now.getTime() / 1000);
  const windowCloseMs = Math.min(now.getTime() + POSITION_WINDOW_MS, arena.expiry * 1000);
  const nonce = `${windowOpen}-${now.getTime().toString(36)}`;
  const windowId = positionWindowId({
    address: addr as `0x${string}`,
    direction: input.direction,
    market: input.market,
    nonce,
  });

  const doc = await EcPosition.create({
    _id: undefined, // generated
    address: addr,
    direction: input.direction,
    market: input.market,
    amount: input.amount,
    arena,
    arenaOpen: openPrice || undefined,
    entryPrice: entryPrice.toString(),
    escrowAddress: ESCROW_ADDRESS,
    status: "ACTIVE",
    windowId: windowId as unknown as string,
    windowOpenAt: now,
    windowCloseAt: new Date(windowCloseMs),
    settledOnchain: false,
    matchCount: 0,
    createdAt: now,
  });

  return { position: doc.toObject(), windowId: windowId as unknown as string, escrow: ESCROW_ADDRESS, entryPrice };
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
  { inWindow = true, debug = false } = {},
): Promise<number> {
  await connectToDatabase();
  reconcileDebug.length = 0;
  const query: Record<string, unknown> = { status: "ACTIVE" };
  if (inWindow) query["windowCloseAt"] = { $lte: new Date() };

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
      // If already settled on-chain, just mark it.
      const onchain = await positionInfo(pos.windowId as `0x${string}`, escrow).catch(() => null);
      entry.onchain = onchain
        ? `open=${onchain.open} settled=${onchain.settled} won=${Number(onchain.won)} escrow=${escrow}`
        : "null(readFailed)";
      if (onchain?.settled) {
        await EcPosition.updateOne(
          { _id: pos._id },
          {
            status: "SETTLED",
            settledWon: onchain.won === 1n,
            settledAt: new Date(),
            settledOnchain: true,
          },
        );
        settled += 1;
        entry.outcome = "already-settled-onchain";
        entry.settledAt = new Date().toISOString();
        continue;
      }
      // A doc that was never funded on-chain (browser stake failed) is a phantom.
      // There's nothing to settle or collect — drop it so it never blocks.
      if (onchain && !onchain.open) {
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

export class PositionError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
