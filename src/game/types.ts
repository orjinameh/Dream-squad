import { type CharacterDef } from "./characters";

export type GamePhase =
  | "HOME"
  | "MODE_SELECT"
  | "CHAR_SELECT"
  | "DUEL_CONFIRM"
  | "MATCH_INTRO"
  | "ROUND_START"
  | "ROUND_ACTIVE"
  | "ROUND_LOCKED"
  | "ROUND_REVEAL"
  | "ROUND_IMPACT"
  | "MATCH_RESULT";

export type GameMode = { id: string; name: string; icon: string; rounds: number; desc: string };

export const GAME_MODES: GameMode[] = [
  { id: "quick", name: "QUICK", icon: "\u26A1", rounds: 3, desc: "~30s of active play" },
  { id: "clash", name: "CLASH", icon: "\uD83D\uDD25", rounds: 5, desc: "~50s of active play" },
  { id: "battle", name: "BATTLE", icon: "\u2694\uFE0F", rounds: 7, desc: "~70s of active play" },
  { id: "war", name: "DREAM WAR", icon: "\uD83D\uDC51", rounds: 11, desc: "~110s of active play" },
];

export type Prediction = "UP" | "DOWN" | null;

export interface RoundResult {
  roundNum: number;
  actual: "UP" | "DOWN";
  playerPredicted: Prediction;
  rivalPredicted: Prediction;
  playerCorrect: boolean;
  rivalCorrect: boolean;
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
}
