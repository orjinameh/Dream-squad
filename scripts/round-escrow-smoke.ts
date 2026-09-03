/* Live on-chain sanity check of DreamDuelRoundEscrow using the keccak-derived
 * match key. Stakes one round as the operator, settles it won, reads the payout.
 * Run: set -a; . ./.env; set +a; npx tsx scripts/round-escrow-smoke.ts
 */
import { createWalletClient, createPublicClient, http, parseUnits, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EC_CHAIN, EC_RPC_URL, ROUND_ESCROW_ADDRESS, EC_ADDRESSES } from "../src/lib/ec/config";
import { DREAMDUEL_ROUND_ESCROW_ABI } from "../src/lib/ec/escrowAbi";

const TUSDC: `0x${string}` = (EC_ADDRESSES.testUsdc ?? EC_ADDRESSES.collateral)!;
const TUSDC_ABI = [
  { type: "function", name: "balanceOf", inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "allowance", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "approve", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable" },
  { type: "function", name: "faucet", inputs: [{ name: "amount", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "transfer", inputs: [{ name: "to", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable" },
] as const;

const pk = process.env.OPERATOR_PRIVATE_KEY as `0x${string}`;
if (!pk) throw new Error("OPERATOR_PRIVATE_KEY not set");

const account = privateKeyToAccount(pk);
const wallet = createWalletClient({ account, chain: EC_CHAIN, transport: http(EC_RPC_URL) });
const pc = createPublicClient({ chain: EC_CHAIN, transport: http(EC_RPC_URL) });

function matchKey(id: string, player?: string) {
  const p = player ? player.toLowerCase() : "";
  return keccak256(toHex(`${id}:${p}`));
}

async function wait(hash: `0x${string}`) {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await pc.getTransactionReceipt({ hash });
      if (r) {
        if (r.status === "reverted") throw new Error(`tx reverted: ${hash}`);
        return r;
      }
    } catch (e: any) {
      if (e?.message?.includes("reverted")) throw e;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("tx not mined");
}

async function main() {
  const matchId = `smoke-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const key = matchKey(matchId, account.address);
  const round = 1;
  const amount = parseUnits("5", 6); // 5 tUSDC
  const entry = 500_000n; // 0.50

  console.log("matchId:", matchId);
  console.log("derived bytes32 key:", key);

  const bal = await pc.readContract({ address: TUSDC, abi: TUSDC_ABI, functionName: "balanceOf", args: [account.address] });
  console.log("operator tUSDC balance:", bal.toString());

  // Operator (admin) needs tUSDC to stake/settle and to back the profit pool.
  if (bal < amount) {
    const want = amount * 3n;
    const fh = await wallet.writeContract({ address: TUSDC, abi: TUSDC_ABI, functionName: "faucet", args: [want], account, chain: EC_CHAIN, gas: 1_000_000n });
    await wait(fh);
    console.log("fauceted operator:", (await pc.readContract({ address: TUSDC, abi: TUSDC_ABI, functionName: "balanceOf", args: [account.address] })).toString());
  }

  const allow = await pc.readContract({ address: TUSDC, abi: TUSDC_ABI, functionName: "allowance", args: [account.address, ROUND_ESCROW_ADDRESS] });
  console.log("allowance:", allow.toString());
  if (allow < amount) {
    const ah = await wallet.writeContract({ address: TUSDC, abi: TUSDC_ABI, functionName: "approve", args: [ROUND_ESCROW_ADDRESS, amount], account, chain: EC_CHAIN });
    await wait(ah);
    console.log("approved escrow:", ah);
  }

  const sh = await wallet.writeContract({
    address: ROUND_ESCROW_ADDRESS, abi: DREAMDUEL_ROUND_ESCROW_ABI, functionName: "stakeRound",
    args: [key, BigInt(round), amount, entry], account, chain: EC_CHAIN,
  });
  await wait(sh).catch((e) => { console.error("STAKEROUND FAILED:", e); throw e; });
  console.log("stakeRound tx:", sh);

  const lock = await pc.readContract({ address: ROUND_ESCROW_ADDRESS, abi: DREAMDUEL_ROUND_ESCROW_ABI, functionName: "roundLock", args: [key, BigInt(round)] });
  console.log("roundLock:", JSON.stringify(lock, (k, v) => typeof v === "bigint" ? v.toString() : v));

  const seth = await wallet.writeContract({
    address: ROUND_ESCROW_ADDRESS, abi: DREAMDUEL_ROUND_ESCROW_ABI, functionName: "settleRound",
    args: [key, BigInt(round), true], account, chain: EC_CHAIN,
  });
  await wait(seth).catch((e) => { console.error("SETTLEROUND FAILED:", e); throw e; });
  console.log("settleRound(won) tx:", seth);

  const wd = await pc.readContract({ address: ROUND_ESCROW_ADDRESS, abi: DREAMDUEL_ROUND_ESCROW_ABI, functionName: "withdrawable", args: [key] });
  console.log("withdrawable:", wd.toString(), `(expected payout = 5e6/5e5 = 10e6)`);

  const owner = await pc.readContract({ address: ROUND_ESCROW_ADDRESS, abi: DREAMDUEL_ROUND_ESCROW_ABI, functionName: "matchOwner", args: [key] });
  console.log("matchOwner:", owner, "=== operator:", account.address, "->", String(owner).toLowerCase() === String(account.address).toLowerCase());
  console.log("SMOKE OK");
}

main().catch((e) => { console.error("SMOKE FAIL", e.message); process.exit(1); });
