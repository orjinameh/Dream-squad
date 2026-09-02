import { type CharacterDef } from "./characters";
import { MARKETS } from "@/lib/markets";
import { APPROX_PRICES } from "@/lib/config";

export type FighterState =
  | "idle"
  | "thinking"
  | "locked"
  | "windup"
  | "attack"
  | "hit"
  | "block"
  | "knockback"
  | "stunned"
  | "victory"
  | "defeat";

export type CombatPhase = "idle" | "windup" | "strike" | "impact" | "recovery" | "clash" | "ko";

export type GamePhase =
  | "HOME"
  | "MARKET_SELECT"
  | "CHAR_SELECT"
  | "DUEL_CONFIRM"
  | "PREDICTION_SELECT"
  | "POSITION"
  | "MATCH_TYPE"
  | "MATCHMAKING"
  | "MATCH_FOUND"
  | "READY_UP"
  | "MATCH_INTRO"
  | "ROUND_START"
  | "ROUND_ACTIVE"
  | "ROUND_LOCKED"
  | "ROUND_EXECUTING"
  | "ROUND_REVEAL"
  | "ROUND_IMPACT"
  | "MATCH_RESULT"
  | "PROFILE"
  | "MATCH_HISTORY"
  | "STAKE_HISTORY"
  | "MATCH_DETAIL";

export type GameMode = { id: string; name: string; icon: string; rounds: number; desc: string };

/** Single fixed duel length. The round-count picker was removed: every duel is
 *  now exactly this many rounds, so the header, the create request, and the
 *  round loop all agree and can never diverge (the old bug where a 3-round
 *  game ran to round 7 came from these disagreeing). */
export const DEFAULT_MODE: GameMode = {
  id: "duel",
  name: "DUEL",
  icon: "\u2694\uFE0F",
  rounds: 7,
  desc: "7 rounds of live trading",
};

/** A market the player can choose to trade on the DestinySOM pool. Backed by
 *  the on-chain MARKETS registry so the picker reflects what can actually
 *  execute. */
export interface TradeMarket {
  /** Canonical pair symbol (SOMI:tUSDC / WETH:tUSDC / WBTC:tUSDC). */
  symbol: string;
  /** Friendly base token label (SOMI / WETH / WBTC). */
  asset: string;
  /** Question shown on the chart. */
  question: string;
  /** Accent color for the card/chart. */
  color: string;
  /** Approximate USD reference price. */
  price: number;
  /** Pool minimum order size in base units. */
  minAmount: number;
  /** Lot size in base units. */
  lotSize: number;
  /** true when the pool is deployed on testnet and can execute on-chain today. */
  live: boolean;
}

export const TRADE_MARKETS: TradeMarket[] = (
  ["WETH:tUSDC", "WBTC:tUSDC"] as const
).map((symbol) => {
  const m = MARKETS[symbol];
  const asset = symbol === "WBTC:tUSDC" ? "BTC" : "ETH";
  // Binary contracts on DreamDEX are strictly BTC and ETH. Both are live
  // deployable pools; bets/payouts settle in tUSDC.
  const live = true;
  const color = asset === "BTC" ? "#f59e0b" : "#627eea";
  return {
    symbol,
    asset,
    question: `WILL ${asset} GO UP OR DOWN?`,
    color,
    price: APPROX_PRICES[symbol] ?? 1,
    minAmount: m.minAmount,
    lotSize: m.lotSize,
    live,
  };
});

export const DEFAULT_TRADE_MARKET: TradeMarket = TRADE_MARKETS[0];

export type Prediction = "UP" | "DOWN" | null;

export type BotDifficulty = "easy" | "normal" | "hard";

export interface PredictionConfig {
  id: string;
  asset: string;
  question: string;
  color: string;
  prediction?: "UP" | "DOWN";
}

export const PREDICTIONS: PredictionConfig[] = [
  { id: "btc", asset: "BTC", question: "WILL BTC GO UP OR DOWN?", color: "#f59e0b" },
  { id: "eth", asset: "ETH", question: "WILL ETH GO UP OR DOWN?", color: "#627eea" },
];

export interface RoundResult {
  roundNum: number;
  actual: "UP" | "DOWN" | "FLAT";
  playerPredicted: Prediction;
  rivalPredicted: Prediction;
  playerCorrect: boolean;
  rivalCorrect: boolean;
  playerDamage: number;
  rivalDamage: number;
  isCritical: boolean;
  isDraw: boolean;
  knockout: boolean;
  startPrice?: number;
  endPrice?: number;
  prices?: number[];
  asset?: string;
  playerPnL?: number;
  rivalPnL?: number;
  playerExecution?: {
    status: string;
    txHash?: string;
    direction?: string;
    error?: string;
  };
  rivalExecution?: {
    status: string;
    txHash?: string;
    direction?: string;
    error?: string;
  };
}

export interface GameState {
  phase: GamePhase;
  mode: GameMode | null;
  playerChar: CharacterDef | null;
  rivalChar: CharacterDef | null;
  rivalName: string;
  currentRound: number;
  totalRounds: number;
  playerScore: number;
  rivalScore: number;
  playerStreak: number;
  rivalStreak: number;
  timeLeft: number;
  playerPrediction: Prediction;
  roundResult: RoundResult | null;
  roundHistory: RoundResult[];
  hitEffect: "none" | "player-hit" | "rival-hit" | "both-hit";
  shakeScreen: boolean;
  showStreak: string | null;
  executionStatus: "idle" | "executing" | "success" | "failed" | "retrying";
  executionError: string | null;
  lastTxHash: string | null;
  playerHP: number;
  rivalHP: number;
  maxHP: number;
  combatPhase: CombatPhase;
  lastDamage: { amount: number; target: "player" | "rival"; isCritical: boolean } | null;
  isFinalRound: boolean;
  koOverlay: string | null;
  // Coherent market series for the current round (chart + resolution agree)
  market?: {
    asset: string;
    startPrice: number;
    endPrice: number;
    prices: number[];
    actual: "UP" | "DOWN" | "FLAT";
  };
  // Trading balances (STT)
  playerBalance: number;
  rivalBalance: number;
  playerStartBalance: number;
  rivalStartBalance: number;
  // Per-player independent trade amount (STT) — each player's own stake.
  playerAmountPerRound?: number;
  rivalAmountPerRound?: number;
}
