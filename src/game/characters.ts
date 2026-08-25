export interface CharacterDef {
  id: string;
  name: string;
  title: string;
  colors: { skin: string; hair: string; outfit: string; accent: string; boot: string };
  desc: string;
}

export const CHARACTERS: CharacterDef[] = [
  {
    id: "oracle",
    name: "ORACLE",
    title: "The Market Seer",
    colors: { skin: "#e8c170", hair: "#6b21a8", outfit: "#1e1b4b", accent: "#a855f7", boot: "#312e81" },
    desc: "Reads the invisible currents of the market",
  },
  {
    id: "degen",
    name: "DEGEN",
    title: "The Reckless One",
    colors: { skin: "#f0c8a0", hair: "#1a1a2e", outfit: "#111827", accent: "#f97316", boot: "#1f2937" },
    desc: "All-in. Every time. No regrets.",
  },
  {
    id: "quant",
    name: "QUANT",
    title: "The Algorithm",
    colors: { skin: "#94a3b8", hair: "#475569", outfit: "#0f172a", accent: "#22d3ee", boot: "#1e293b" },
    desc: "Calculates 10,000 outcomes before you blink",
  },
  {
    id: "ape",
    name: "APE",
    title: "The Chaos Engine",
    colors: { skin: "#a0714f", hair: "#78350f", outfit: "#451a03", accent: "#eab308", boot: "#713f12" },
    desc: "Smashes buttons. Smashes markets.",
  },
  {
    id: "dreamer",
    name: "DREAMER",
    title: "The Original",
    colors: { skin: "#fbbf24", hair: "#065f46", outfit: "#022c22", accent: "#10b981", boot: "#064e3b" },
    desc: "Balanced. Precise. Inevitable.",
  },
  {
    id: "shadow",
    name: "SHADOW",
    title: "The Phantom",
    colors: { skin: "#cbd5e1", hair: "#1e1b4b", outfit: "#0c0a1d", accent: "#6366f1", boot: "#1a1625" },
    desc: "Strikes from the dark. Never misses.",
  },
];

export const RIVAL_NAMES = [
  "GHOST_TRADER", "MOON_HAWK", "FLUX_ZERO", "RIKO_88", "SIGNAL_V",
  "NODE_RUNNER", "DELTA_X", "PULSE_9", "VOID_BOT", "ECHO_7",
  "TURBO_ACE", "CIPHER_K", "BLITZ_O", "SHARD_3", "ZENITH_R",
];
