export interface RankInfo {
  rank: string;
  tier: number;
  color: string;
  icon: string;
}

const RANKS: { name: string; min: number; color: string; icon: string }[] = [
  { name: "LEGEND", min: 2500, color: "#fbbf24", icon: "\uD83D\uDC51" },
  { name: "DIAMOND", min: 2000, color: "#22d3ee", icon: "\u25C6" },
  { name: "GOLD", min: 1500, color: "#f59e0b", icon: "\u2B50" },
  { name: "SILVER", min: 1000, color: "#94a3b8", icon: "\u25C9" },
  { name: "BRONZE", min: 0, color: "#b45309", icon: "\u25CF" },
];

const TIER_NAMES = ["", "I", "II", "III", "IV", "V"];

export function getRankFromPoints(points: number): RankInfo {
  let tierPoints = points;
  for (const r of RANKS) {
    if (tierPoints >= r.min) {
      const offset = tierPoints - r.min;
      const tierIndex = Math.min(Math.floor(offset / 100) + 1, 5);
      return { rank: r.name, tier: tierIndex, color: r.color, icon: r.icon };
    }
  }
  return { rank: "BRONZE", tier: 5, color: "#b45309", icon: "\u25CF" };
}

export function getRankLabel(points: number): string {
  const info = getRankFromPoints(points);
  return `${info.rank} ${TIER_NAMES[info.tier]}`;
}

export function getPvpWinPoints(isWin: boolean, isDraw: boolean): number {
  if (isDraw) return 0;
  return isWin ? 15 : -10;
}
