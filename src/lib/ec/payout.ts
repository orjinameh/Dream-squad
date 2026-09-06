import { adminWallet, publicClient } from "./escrow";
import { EC_CHAIN, EC_ADDRESSES, EC_COLLATERAL_DECIMALS, EC_TX_GAS_PRICE } from "./config";

/**
 * Instant per-round payout: operator transfers tUSDC to the player's wallet
 * immediately after a round win. The operator recoups later via
 * settleRoundStakes() which redeems the won DreamDEX position.
 *
 * Flow:
 *   1. Read operator's tUSDC balance
 *   2. If below payout, mint shortfall via public faucet()
 *   3. ERC20 transfer the payout to the player
 *
 * Idempotent: safe to call multiple times for the same player/round.
 * Fire-and-forget: errors are caught and logged, never block the match.
 */

const TUSDC_ADDRESS: `0x${string}` = (EC_ADDRESSES.testUsdc ?? EC_ADDRESSES.collateral)!;

const TUSDC_ABI = [
  {
    type: "function",
    name: "faucet",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const GAS_LIMIT = 3_000_000n;

/**
 * Transfer `amountHuman` tUSDC (human-readable, e.g. 1.5) to `playerAddress`.
 * Mints from the public faucet if the operator is short.
 *
 * Returns `{ txHash }` on success or `{ error }` on failure.
 */
export async function payoutTusdc(
  playerAddress: `0x${string}`,
  amountHuman: number,
): Promise<{ txHash?: string; error?: string }> {
  if (amountHuman <= 0) return {};

  const amountRaw = BigInt(Math.round(amountHuman * 10 ** EC_COLLATERAL_DECIMALS));

  try {
    const wc = adminWallet();
    const pc = publicClient();
    const operator = wc.account!.address as `0x${string}`;

    // Ensure the operator has enough tUSDC — mint any shortfall.
    const opBal = (await pc.readContract({
      address: TUSDC_ADDRESS,
      abi: TUSDC_ABI,
      functionName: "balanceOf",
      args: [operator],
    })) as bigint;

    if (opBal < amountRaw) {
      const shortfall = amountRaw - opBal;
      try {
        const mintTx = await wc.writeContract({
          address: TUSDC_ADDRESS,
          abi: TUSDC_ABI,
          functionName: "faucet",
          args: [shortfall],
          chain: EC_CHAIN,
          account: wc.account!,
          gas: GAS_LIMIT,
        });
        await pc.waitForTransactionReceipt({ hash: mintTx });
      } catch (mintErr: any) {
        console.error("[payout] tUSDC faucet failed", mintErr?.shortMessage ?? mintErr?.message);
        return { error: `faucet failed: ${mintErr?.shortMessage ?? mintErr?.message}` };
      }
    }

    // Transfer tUSDC to the player.
    const txHash = await wc.writeContract({
      address: TUSDC_ADDRESS,
      abi: TUSDC_ABI,
      functionName: "transfer",
      args: [playerAddress, amountRaw],
      chain: EC_CHAIN,
      account: wc.account!,
      gas: GAS_LIMIT,
    });
    await pc.waitForTransactionReceipt({ hash: txHash });

    return { txHash };
  } catch (err: any) {
    console.error("[payout] tUSDC transfer failed", err?.shortMessage ?? err?.message);
    return { error: `transfer failed: ${err?.shortMessage ?? err?.message}` };
  }
}
