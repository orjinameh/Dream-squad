import { connectToDatabase } from "@/db/connect";
import { EcPosition } from "@/db/models/EcPosition";
import { findArenaFloor, readArenaPrice, readArenaSettlement } from "./executor";
import { positionWindowId } from "./matchId";
import { positionInfo, settleWindowOnchain, collectLostOnchain, positionOpen } from "./escrow";

const POSITION_WINDOW_MS = 15 * 60 * 1000; // ~15 minute DreamDEX window

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

  const existing = await EcPosition.findOne({ address: addr, status: "ACTIVE" }).lean();
  if (existing) {
    throw new PositionError(409, "you already have an active EC position. Settle it or switch direction by opening a new one.");
  }

  // Pin the live EC arena floor (the 15-min window the position rides).
  const arena = await findArenaFloor(input.market, 30);
  if (!arena) {
    throw new PositionError(503, "no live Event Contract window right now — try again in a moment");
  }
  const openPrice = await readArenaPrice(arena).then((q) => (q.yesPrice && q.yesPrice > 0 ? q.yesPrice : 0)).catch(() => 0);

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
    status: "ACTIVE",
    windowId: windowId as unknown as string,
    windowOpenAt: now,
    windowCloseAt: new Date(windowCloseMs),
    settledOnchain: false,
    matchCount: 0,
    createdAt: now,
  });

  return { position: doc.toObject(), windowId: windowId as unknown as string };
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
export async function reconcilePositions({ inWindow = true } = {}): Promise<number> {
  await connectToDatabase();
  const query: Record<string, unknown> = { status: "ACTIVE" };
  if (inWindow) query["windowCloseAt"] = { $lte: new Date() };

  const active = await EcPosition.find(query).lean();
  let settled = 0;

  for (const pos of active) {
    try {
      if (!pos.windowId) continue;
      // If already settled on-chain, just mark it.
      const onchain = await positionInfo(pos.windowId as `0x${string}`).catch(() => null);
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
        continue;
      }
      // Resolve the real outcome and implement it on-chain.
      const won = await resolvePositionOutcome(pos);
      if (won === null) continue;
      const win = won as boolean;
      await settleWindowOnchain(pos.windowId as `0x${string}`, win);
      if (!win) {
        await collectLostOnchain(pos.windowId as `0x${string}`).catch(() => {});
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
      settled += 1;
    } catch (err) {
      console.error(`[position] reconcile failed for ${pos._id}`, err);
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
