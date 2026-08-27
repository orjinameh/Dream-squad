// @vitest-environment jsdom
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { create as renderer, act } from "react-test-renderer";
import { useGameState, type GameHook } from "@/game/useGameState";
import { CHARACTERS } from "@/game/characters";

const PLAYER = "0x9196d7670eea0CB723af11465d4285541a2eA86a";

let MOCK_ADDRESS: string | null = PLAYER;
vi.mock("wagmi", () => ({
  useAccount: () => ({ address: MOCK_ADDRESS, isConnected: !!MOCK_ADDRESS, isDisconnected: !MOCK_ADDRESS }),
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
    totalRounds: 3,
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

function resolveNextRound() {
  const n = resolveState.currentRound;
  const last = resolveState.rounds[resolveState.rounds.length - 1] ?? null;
  const playerScore = (last?.playerScore ?? 0);
  const rnd: any = {
    roundNum: n,
    playerPrediction: "UP",
    rivalPrediction: "DOWN",
    actual: "UP",
    playerCorrect: true,
    rivalCorrect: false,
    roundWinner: "player",
    damage: 15,
    playerDamage: 0,
    rivalDamage: 15,
    isCritical: false,
    knockout: false,
    startPrice: 67000,
    endPrice: 67600,
    prices: [67000, 67600],
    asset: "BTC",
    playerPnL: 1,
    rivalPnL: -1,
    playerExecution: { status: "EXECUTED", txHash: "0x" + n, direction: "BUY", amount: 1 },
    rivalExecution: { status: "EXECUTED", direction: "SELL", amount: 1 },
    playerScore: playerScore + 1,
    rivalScore: 0,
  };
  resolveState.rounds = [...resolveState.rounds, rnd];
  resolveState.playerScore = playerScore + 1;
  resolveState.currentRound = n + 1;
  resolveState.roundPhase = n >= 3 ? "REVEALED" : "ACTIVE";
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
      const data = resolveNextRound();
      return new Response(JSON.stringify({
        serverTime: new Date().toISOString(),
        roundPhase: resolveState.roundPhase,
        roundDeadline: new Date().toISOString(),
        playerScore: resolveState.playerScore,
        rivalScore: resolveState.rivalScore,
        playerPrediction: "UP",
        rivalPrediction: "DOWN",
        rounds: resolveState.rounds,
        winner: "player",
        totalRounds: 3,
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

describe("client bot game full loop", () => {
  beforeEach(() => {
    mockFetch();
    resolveState = { currentRound: 1, roundPhase: "ACTIVE", rounds: [], playerScore: 0, rivalScore: 0 };
    latest = null;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("advances through all 3 rounds and reaches MATCH_RESULT", async () => {
    let r: any;
    act(() => {
      r = renderer(<Probe />);
    });

    // Full bot flow
    act(() => { latest!.actions.selectMode({ id: "quick", name: "QUICK", rounds: 3, desc: "" }); });
    await waitFor((h) => h.phase === "CHAR_SELECT", 3000, "CHAR_SELECT");
    act(() => { latest!.actions.selectChar(CHARACTERS[0]); });
    await waitFor((h) => h.phase === "DUEL_CONFIRM", 3000, "DUEL_CONFIRM");
    act(() => { latest!.actions.confirmDuel(); });
    await waitFor((h) => h.phase === "PREDICTION_SELECT", 3000, "PREDICTION_SELECT");
    act(() => { latest!.actions.selectPrediction({ id: "btc", asset: "BTC", question: "", color: "#000" }); });
    await waitFor((h) => h.phase === "ROUND_ACTIVE", 10_000, "first ROUND_ACTIVE");

    // Make a prediction on round 1, then let subsequent rounds resolve via the
    // bot countdown timer (the realistic "no-pick" auto-play path).
    act(() => { latest!.actions.makePrediction("UP"); });
    await waitFor((h) => h.roundHistory.length >= 1, 30_000, "round 1 resolved");

    // Should advance automatically through rounds 2 and 3 without further taps
    await waitFor((h) => h.currentRound === 3 && h.phase === "ROUND_ACTIVE", 40_000, "round 3 ACTIVE");
    await waitFor((h) => h.roundHistory.length >= 3, 40_000, "round 3 resolved");

    await waitFor((h) => h.phase === "MATCH_RESULT", 40_000, "MATCH_RESULT");

    console.log("FULL BOT GAME OK", {
      phase: latest!.phase,
      roundHistory: latest!.roundHistory.length,
      playerScore: latest!.playerScore,
    });
    r?.unmount();
  }, 120_000);

  it("bot game WITHOUT a connected wallet does not freeze", async () => {
    MOCK_ADDRESS = null; // no wallet connected
    let r: any;
    act(() => {
      r = renderer(<Probe />);
    });

    act(() => { latest!.actions.selectMode({ id: "quick", name: "QUICK", rounds: 3, desc: "" }); });
    await waitFor((h) => h.phase === "CHAR_SELECT", 3000, "CHAR_SELECT");
    act(() => { latest!.actions.selectChar(CHARACTERS[0]); });
    await waitFor((h) => h.phase === "DUEL_CONFIRM", 3000, "DUEL_CONFIRM");
    act(() => { latest!.actions.confirmDuel(); });
    await waitFor((h) => h.phase === "PREDICTION_SELECT", 3000, "PREDICTION_SELECT");
    act(() => { latest!.actions.selectPrediction({ id: "btc", asset: "BTC", question: "", color: "#000" }); });
    await waitFor((h) => h.phase === "ROUND_ACTIVE", 10_000, "first ROUND_ACTIVE");

    // Do nothing — let the bot countdown auto-submit. If submitPrediction returns
    // null (no wallet), the round will never advance and this waitFor times out.
    await waitFor((h) => h.roundHistory.length >= 1, 25_000, "round 1 resolved WITHOUT wallet");
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
    act(() => { latest!.actions.selectMode({ id: "quick", name: "QUICK", rounds: 3, desc: "" }); });
    await waitFor((h) => h.phase === "CHAR_SELECT", 3000, "CHAR_SELECT");
    act(() => { latest!.actions.selectChar(CHARACTERS[0]); });
    await waitFor((h) => h.phase === "DUEL_CONFIRM", 3000, "DUEL_CONFIRM");
    act(() => { latest!.actions.confirmDuel(); });
    await waitFor((h) => h.phase === "PREDICTION_SELECT", 3000, "PREDICTION_SELECT");
    act(() => { latest!.actions.selectPrediction({ id: "btc", asset: "BTC", question: "", color: "#000" }); });
    await waitFor((h) => h.phase === "ROUND_ACTIVE", 10_000, "first ROUND_ACTIVE");

    // Tap a prediction — first submit fails (500), retry must succeed.
    act(() => { latest!.actions.makePrediction("UP"); });
    await waitFor((h) => h.roundHistory.length >= 1, 25_000, "round 1 resolved after retry");
    expect(predictCalls).toBeGreaterThanOrEqual(2);
    r?.unmount();
  }, 60_000);
});
