// @vitest-environment jsdom
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { create as renderer, act } from "react-test-renderer";
import { useGameState, type GameHook } from "@/game/useGameState";
import { DEFAULT_TRADE_MARKET } from "@/game/types";

const PLAYER = "0x9196d7670eea0CB723af11465d4285541a2eA86a";

vi.mock("wagmi", () => ({
  useAccount: () => ({ address: PLAYER, isConnected: true, isDisconnected: false }),
}));

let resolveState: { currentRound: number; roundPhase: string; rounds: any[]; playerScore: number; rivalScore: number } = {
  currentRound: 1,
  roundPhase: "ACTIVE",
  rounds: [],
  playerScore: 0,
  rivalScore: 0,
};

function buildState() {
  return {
    matchId: "m-bot-1",
    status: "ACTIVE",
    mode: "quick",
    totalRounds: 7,
    currentRound: resolveState.currentRound,
    roundPhase: resolveState.roundPhase,
    roundStartTime: new Date().toISOString(),
    roundDeadline: new Date(Date.now() + 10_000).toISOString(),
    serverTime: new Date().toISOString(),
    playerScore: resolveState.playerScore,
    rivalScore: resolveState.rivalScore,
    playerPrediction: null,
    rivalPrediction: null,
    rounds: resolveState.rounds,
    winner: "player",
    opponentType: "bot",
    playerHP: 100,
    rivalHP: 100,
    playerStreak: 0,
    rivalStreak: 0,
    playerStartBalance: 100,
    rivalStartBalance: 100,
    playerBalance: 100,
    rivalBalance: 100,
  };
}

function resolveNextRound(pred: "UP" | "DOWN") {
  const n = resolveState.currentRound;
  const last = resolveState.rounds[resolveState.rounds.length - 1] ?? null;
  const playerScore = (last?.playerScore ?? 0);
  const actual = "UP";
  const playerCorrect = pred === actual;
  const rnd: any = {
    roundNum: n,
    playerPrediction: pred,
    rivalPrediction: "DOWN",
    actual,
    playerCorrect,
    rivalCorrect: false,
    roundWinner: playerCorrect ? "player" : "rival",
    damage: 15,
    playerDamage: playerCorrect ? 0 : 15,
    rivalDamage: playerCorrect ? 15 : 0,
    isCritical: false,
    knockout: false,
    startPrice: 67000,
    endPrice: 67600,
    prices: [67000, 67600],
    asset: "BTC",
    playerPnL: playerCorrect ? 1 : -1,
    rivalPnL: -1,
    playerExecution: { status: "EXECUTED", txHash: "0x" + n, direction: pred === "UP" ? "BUY" : "SELL", amount: 1 },
    rivalExecution: { status: "EXECUTED", direction: "SELL", amount: 1 },
    playerScore: playerScore + (playerCorrect ? 1 : 0),
    rivalScore: 0,
  };
  resolveState.rounds = [...resolveState.rounds, rnd];
  resolveState.playerScore = playerScore + (playerCorrect ? 1 : 0);
  resolveState.currentRound = n + 1;
  resolveState.roundPhase = n >= 7 ? "REVEALED" : "ACTIVE";
  return { roundNum: n, rounds: resolveState.rounds, currentRound: n + 1 };
}

function mockFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.includes("/api/matches/create")) {
      resolveState = { currentRound: 1, roundPhase: "ACTIVE", rounds: [], playerScore: 0, rivalScore: 0 };
      const body = { matchId: "m-bot-1", serverTime: new Date().toISOString(), roundStartTime: new Date().toISOString(), roundDeadline: new Date().toISOString() };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (path.includes("/api/matches/state")) {
      return new Response(JSON.stringify(buildState()), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (path.includes("/api/matches/predict")) {
      let pred: "UP" | "DOWN" = "UP";
      try {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (body.prediction === "UP" || body.prediction === "DOWN") pred = body.prediction;
      } catch { /* ignore */ }
      const data = resolveNextRound(pred);
      return new Response(JSON.stringify({
        serverTime: new Date().toISOString(),
        roundPhase: resolveState.roundPhase,
        roundDeadline: new Date().toISOString(),
        playerScore: resolveState.playerScore,
        rivalScore: resolveState.rivalScore,
        playerPrediction: pred,
        rivalPrediction: "DOWN",
        rounds: resolveState.rounds,
        winner: "player",
        totalRounds: 7,
        currentRound: resolveState.currentRound,
        playerHP: 100,
        rivalHP: 85,
        ...data,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }));
}

let latest: GameHook | null = null;
function Probe() {
  latest = useGameState();
  return null;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(pred: (h: GameHook) => boolean, timeoutMs = 60_000, label = "condition") {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (latest && pred(latest)) return;
    await act(async () => {
      await sleep(200);
    });
  }
  throw new Error(`TIMEOUT waiting for ${label}. Latest phase=${latest?.phase}`);
}

// Drive the hook from HOME to a live bot ROUND_ACTIVE via the current screen
// flow: MARKET -> POSITION (stake opens a position) -> MATCH_TYPE -> BOT.
async function openToRoundActive(pred: "UP" | "DOWN") {
  act(() => { latest!.actions.selectMarket(DEFAULT_TRADE_MARKET); });
  await waitFor((h) => h.phase === "POSITION", 3000, "POSITION");

  // POSITION screen: stake up front (open the position record), then unlock
  // the CHOOSE MATCH TYPE button.
  act(() => {
    latest!.actions.openPosition({ direction: pred, market: "BTC", amount: 10, positionId: "pos-1", windowId: "win-1", stakeTxHash: null, entryPrice: "500000" });
  });
  await waitFor((h) => h.hasActivePosition === true, 3000, "hasActivePosition");
  act(() => { latest!.actions.goToMatchType(); });
  await waitFor((h) => h.phase === "MATCH_TYPE", 3000, "MATCH_TYPE");

  // Lock the pre-match call, then fight the bot (skips CHAR_SELECT — the
  // match starts straight into the intro/fight).
  act(() => { latest!.actions.setMatchPrediction(pred); });
  act(() => { latest!.actions.fightBotInstead(); });
  await waitFor((h) => h.phase === "ROUND_ACTIVE", 10_000, "first ROUND_ACTIVE");
}

describe("client bot game full loop", () => {
  beforeEach(() => {
    mockFetch();
    resolveState = { currentRound: 1, roundPhase: "ACTIVE", rounds: [], playerScore: 0, rivalScore: 0 };
    latest = null;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("advances through all 7 rounds and reaches MATCH_RESULT", async () => {
    let r: any;
    act(() => {
      r = renderer(<Probe />);
    });

    // Full bot flow — pick the call up front (locked), then fight the bot.
    await openToRoundActive("UP");

    // Every round auto-uses the locked pre-match call (no in-match picking).
    await waitFor((h) => h.roundHistory.length >= 1, 30_000, "round 1 resolved");

    // Should advance automatically through the remaining rounds without further taps
    await waitFor((h) => h.currentRound === 7 && h.phase === "ROUND_ACTIVE", 40_000, "round 7 ACTIVE");
    await waitFor((h) => h.roundHistory.length >= 7, 40_000, "round 7 resolved");

    await waitFor((h) => h.phase === "MATCH_RESULT", 40_000, "MATCH_RESULT");

    console.log("FULL BOT GAME OK", {
      phase: latest!.phase,
      roundHistory: latest!.roundHistory.length,
      playerScore: latest!.playerScore,
    });
    r?.unmount();
  }, 120_000);

  it("seeds the round with the pre-match call, which is flippable per-round", async () => {
    let r: any;
    act(() => { r = renderer(<Probe />); });
    await openToRoundActive("UP");

    // The pre-match call is seeded into the open round for round 1.
    expect(latest!.playerPrediction).toBe("UP");
    expect(latest!.lockedCall).toBe("UP");

    // The round must NOT resolve instantly on the pick — it stays open (timer running).
    expect(latest!.roundHistory.length).toBe(0);
    expect(latest!.phase).toBe("ROUND_ACTIVE");

    // Per-round model: the call is flippable while the round is live — flipping
    // re-submits the new side for THIS round, which resolves with the new call.
    act(() => { latest!.actions.makePrediction("DOWN"); });
    expect(latest!.playerPrediction).toBe("DOWN");
    expect(latest!.lockedCall).toBe("UP"); // the saved pre-match call is unchanged

    // Resolves when the round closes (timeout), with the flipped call.
    await waitFor((h) => h.roundHistory.length >= 1, 25_000, "round resolves at close (not on pick)");
    expect(latest!.roundHistory[0]?.playerPredicted).toBe("DOWN");
    r?.unmount();
  }, 60_000);

  it("bot game survives a transient submit failure (retry resolves the round)", async () => {
    // Make the FIRST predict call fail with a 500, then succeed.
    const realFetch = globalThis.fetch as any;
    let predictCalls = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path.includes("/api/matches/predict")) {
        predictCalls++;
        if (predictCalls === 1) {
          return new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } });
        }
      }
      return realFetch(url, init);
    });

    let r: any;
    act(() => { r = renderer(<Probe />); });
    await openToRoundActive("UP");

    // The round auto-submits the locked call; first submit fails (500), retry must succeed.
    await waitFor((h) => h.roundHistory.length >= 1, 25_000, "round 1 resolved after retry");
    expect(predictCalls).toBeGreaterThanOrEqual(2);
    r?.unmount();
  }, 60_000);
});
