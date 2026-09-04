import { defineChain, fallback, http } from "viem";
import { PLACE_ORDER_FOR_SELECTOR, CANCEL_ORDER_FOR_SELECTOR, type SomniaMarketsAddresses } from "@somnia-chain/markets-sdk";

/**
 * DreamDEX Event Contract (binary YES/NO) trading config for DreamDuel.
 *
 * The binary markets settle in tUSDC on testnet (6 dp, public faucet) and
 * USDso on mainnet (18 dp, no faucet). This build targets the testnet venue,
 * which is the real on-chain trading the hackathon demo runs on.
 */
export const EC_NETWORK = "testnet" as const;

export const EC_CHAIN_ID = 50312;

export const EC_RPC_URL = "https://api.infra.testnet.somnia.network";
export const EC_RPC_WS_URL = "wss://api.infra.testnet.somnia.network/ws";
export const EC_INDEXER_URL = "https://dev.smk.somnia.host/v1/graphql";

// Fallback RPC mirrors for the Somnia testnet (chain 50312, STT). The primary
// infra endpoint rate-limits under load ("too many errors, retrying…"), which
// freezes wallet approve popups (eth_gasPrice) and hides on-chain balance reads.
// viem `fallback` shifts to an alternate mirror instead of failing hard.
export const EC_RPC_URLS = [
  EC_RPC_URL,
  "https://dream-rpc.somnia.network",
  "https://50312.rpc.thirdweb.com",
] as const;

export const ecHttpTransport = () => fallback(EC_RPC_URLS.map((url) => http(url)));

export const EC_CHAIN = defineChain({
  id: EC_CHAIN_ID,
  name: "Somnia Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: {
    default: {
      http: [EC_RPC_URL],
      webSocket: [EC_RPC_WS_URL],
    },
  },
});

/** Testnet Event Contract address set (from @somnia-chain/markets-sdk). */
export const EC_ADDRESSES: SomniaMarketsAddresses = {
  binaryModule: "0x3ecC694Cef705358864a646142ac17A90E29e388",
  marketsCore: "0x2802504314685D89bF6C992CA5a8e7cC78bc0294",
  clobFactory: "0xb2BE8EE02F96379DB75f01802384593EBa9bfF04",
  binaryPoolImpl: "0x82A1FcdaA2daC2fC7D5f9909D43E68021eE966FD",
  binarySettlement: "0xbF4a49e0Dfd092e5FBE8E5761064C49533e6Ed23",
  collateralRouter: "0xbC0C9834B15ACE38bB50dDaa7d7f7C7CC4DC183C",
  marketCreatorFactory: "0xE6bEE93cE87c9E6e62aCb621caa7832EE47b4F6B",
  oracleHub: "0xe40db387cC98601Dd11bd634fF2f3AD5686dE32b",
  collateral: "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E",
  testUsdc: "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E",
  marketCreator: "0x5Ce69567dB39C8fBAd7e048bEfdbcCdfE67B44e6",
};

/** Collateral is tUSDC on testnet — 6 decimal-places. */
export const EC_COLLATERAL_DECIMALS = 6;

/** Selectors the operator needs granted to trade a user's vault. */
export const EC_ORDER_SELECTORS = [PLACE_ORDER_FOR_SELECTOR, CANCEL_ORDER_FOR_SELECTOR] as `0x${string}`[];

/**
 * A binary market's price tick in collateral units per whole YES token.
 * On the testnet venue default is 1000 (0.001 of collateral) for a 6-dp venue.
 */
export const EC_TICK = 1000;
/** Lot (minimum tradable quantity step) in outcome-token units. */
export const EC_LOT = 1;

/**
 * DreamDuel escrow contract (on-chain tUSDC custody for EC POSITIONS).
 * Deployed to Somnia testnet. Players stake a EC position (direction x amount)
 * for a 15-min window; the backend relayer (`admin`) settles the window with
 * the REAL EC settlement outcome (won/lost) and credits/forfeits the stake once.
 *
 * DEPLOYED (v2 window-keyed) via scripts/deploy-escrow.ts — chain 50312, tx
 * 0x0641...8f. Verified: admin, collateral (tUSDC), windowLength (900).
 */
export const ESCROW_ADDRESS = "0xd068e4b26357239d3ea0fd960c781fcb2512c5c9" as `0x${string}`;

/**
 * DreamDuel per-round escrow — on-chain tUSDC settlement for fights that stake
 * and settle PER ROUND (flippable UP/DOWN each round, same stake per round,
 * auto-settled at each round's close). Deployed via scripts/deploy-round-escrow.ts
 * (chain 50312, tx redacted). Clone of the v4 window escrow but keyed by
 * (matchId, round) so each round realizes its own PnL against the live YES-mid.
 */
export const ROUND_ESCROW_ADDRESS = "0x4b5c9d4dec4542a2df02314952cbcc7dae665bdc" as `0x${string}`;

/**
 * Prior escrow deployments. Positions created before a redeploy carry no
 * `escrowAddress`; the app falls back through these so a WON stake on a legacy
 * contract stays withdrawable. Order newest-first by age.
 *  - v3: 0x63159a… — window-keyed, DEX entry-price payout (stake→+900s close)
 *  - v2: 0x1debf7… — window-keyed, flat stake return (holds a settled WON 25)
 */
export const ESCROW_LEGACY_BY_AGE: `0x${string}`[] = [
  "0x63159a329934c42e44b4b9bd20386467dec4b793", // v3
  "0x1debf7cc74b77734fdbef8c18bb8915fc474eb3f", // v2 — window-keyed, flat stake return
];

/** Seconds a player must wait before self-refunding a stuck match. */
export const ESCROW_REFUND_DELAY = 900;

/** The escrow's controlled `admin` is the same operator that drives matches. */
export const ESCROW_ADMIN = "0xdd68998C099f7570E59019ae35469E5603cEDA11" as `0x${string}`;

/**
 * Treasury that receives forfeited solo (bot-match) stakes on a player loss.
 * The deploy script defaults this to `admin` (the operator wallet) unless a
 * distinct house address is configured.
 */
export const ESCROW_HOUSE = ESCROW_ADMIN as `0x${string}`;
