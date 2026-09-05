import { defineChain, parseUnits, zeroAddress } from "viem";
import { EC_RPC_URLS, EC_TX_GAS_PRICE } from "@/lib/ec/config";

// ─── Chain ────────────────────────────────────────────────────────────────────
// Hardcoded to Shannon testnet. The executor never touches mainnet.

// http[0] (NOT dream-rpc) is what MetaMask/wallets store when the dapp auto-
// adds the chain, and it's the mirror that actually serves JSON-RPC today. The
// fees.gasPrice override means viem never issues eth_gasPrice (rate-limited
// here) — every write is fully priced against a fixed 10 gwei before the popup.
export const SOMNIA_CHAIN = defineChain({
  id: 50312,
  name: "Somnia Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: [...EC_RPC_URLS], webSocket: ["wss://api.infra.testnet.somnia.network/ws"] } },
  fees: {
    estimateFeesPerGas: async ({ type }) => (type === "legacy" ? { gasPrice: EC_TX_GAS_PRICE } : null),
  },
  blockExplorers: {
    default: { name: "Shannon Explorer", url: "https://shannon-explorer.somnia.network" },
  },
});

// ─── Minimal Spot Pool ABI ─────────────────────────────────────────────────────
// Only the functions the executor touches. Copied from
// @ec/core/contract.ts:SPOT_POOL_ABI — no runtime import to keep dreamsquad
// self-contained.

export const SPOT_POOL_ABI = [
  {
    type: "function",
    name: "placeOrderFor",
    stateMutability: "payable",
    inputs: [
      { name: "owner", type: "address" },
      { name: "isBid", type: "bool" },
      { name: "userData", type: "uint64" },
      { name: "price", type: "uint256" },
      { name: "quantity", type: "uint256" },
      { name: "expireTimestampNs", type: "uint64" },
      { name: "orderType", type: "uint8" },
      { name: "selfMatchingOption", type: "uint8" },
      { name: "builder", type: "address" },
      { name: "builderFeeBpsTimes1k", type: "uint96" },
    ],
    outputs: [
      { name: "success", type: "bool" },
      { name: "orderId", type: "uint128" },
    ],
  },
  {
    type: "function",
    name: "cancelOrderFor",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" },
      { name: "orderId", type: "uint128" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "isOperatorAuthorized",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "operator", type: "address" },
      { name: "selector", type: "bytes4" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "setManualVaultMode",
    stateMutability: "nonpayable",
    inputs: [{ name: "enabled", type: "bool" }],
    outputs: [],
  },
  {
    type: "function",
    name: "getManualVaultMode",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "depositNative",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
] as const;

// ─── Order types (EC-SDK convention) ──────────────────────────────────────────
export const ORDER_TYPE = {
  LIMIT: 0,
  FOK: 1,
  IOC: 2, // immediate-or-cancel: the syndicate order type
  POST_ONLY: 3,
} as const;

// ─── Crossing prices for IOC market orders ─────────────────────────────────────
// For a BUY (isBid=true), the price is set absurdly high so the IOC order
// crosses every resting ask and fills at the best available.  For a SELL
// (isBid=false), it is set near-zero to cross all resting bids.  Since the
// order is IOC, unfilled quantity is returned to the vault immediately.

export function crossingPrice(direction: "BUY" | "SELL", quoteDecimals: number): bigint {
  if (direction === "BUY") return parseUnits("10", quoteDecimals); // way above any ask
  return parseUnits("0.001", quoteDecimals); // way below any bid
}

export const ZERO_ADDRESS = zeroAddress;

// ─── Operator delegation (Phase 1 proven on Shannon testnet) ───────────────────
// Registry: user calls setOperatorApprovalForPool(pool, operator, selectors, true)
// once to approve the backend key for placeOrderFor + cancelOrderFor.

export const OPERATOR_ADDRESS = "0xdd68998C099f7570E59019ae35469E5603cEDA11" as const;

export const OPERATOR_REGISTRY_ADDRESS = "0x15C7e8CE38F021c5b45d098AaD788f63090bF20A" as const;

export const SELECTORS = {
  placeOrderFor: "0x80054449" as `0x${string}`,
  cancelOrderFor: "0xe37b444b" as `0x${string}`,
};

export const OPERATOR_REGISTRY_ABI = [
  {
    type: "function",
    name: "setOperatorApprovalForPool",
    stateMutability: "nonpayable",
    inputs: [
      { name: "pool", type: "address" },
      { name: "operator", type: "address" },
      { name: "selectors", type: "bytes4[]" },
      { name: "approved", type: "bool" },
    ],
    outputs: [],
  },
] as const;

/** ABI for reading operator authorization status on a pool. */
export const IS_OPERATOR_AUTHORIZED_ABI = [
  {
    type: "function",
    name: "isOperatorAuthorized",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "operator", type: "address" },
      { name: "selector", type: "bytes4" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** Approximate USD prices for dollar-pill conversion. */
export const APPROX_PRICES: Record<string, number> = {
  "SOMI:tUSDC": 0.1,
  "WETH:tUSDC": 3500,
  "WBTC:tUSDC": 95000,
};

/** Convert a round dollar amount to approximate base-token quantity. */
export function dollarsToBase(dollars: number, market: string): number {
  const price = APPROX_PRICES[market] ?? 1;
  return +(dollars / price).toFixed(6);
}
