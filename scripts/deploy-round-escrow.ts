import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, http, encodeAbiParameters, parseAbiParameters } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EC_CHAIN, EC_RPC_URL, ESCROW_ADMIN } from "../src/lib/ec/config.js";
import { EC_ADDRESSES } from "../src/lib/ec/config.js";

/**
 * Deploy DreamDuelRoundEscrow (per-round EC staking) to Somnia testnet.
 *
 * Reads the compiled artifact from contracts/out/, appends the ABI-encoded
 * constructor args ((collateral, admin)), and broadcasts the create tx with the
 * operator key. Mirrors scripts/deploy-escrow.ts.
 *
 * Run:  npx tsx scripts/deploy-round-escrow.ts
 * Env:  OPERATOR_PRIVATE_KEY (the same key the game uses as escrow admin)
 */
async function main() {
  const pk = process.env.OPERATOR_PRIVATE_KEY;
  if (!pk) throw new Error("OPERATOR_PRIVATE_KEY is not set");

  const artifactPath = path.resolve(
    process.cwd(),
    "contracts/out/DreamDuelRoundEscrow.sol/DreamDuelRoundEscrow.json",
  );
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const initcode = artifact.bytecode.object as string;

  const args = encodeAbiParameters(parseAbiParameters("address,address"), [
    EC_ADDRESSES.collateral,
    ESCROW_ADMIN,
  ]);
  const initHex = initcode.startsWith("0x") ? initcode.slice(2) : initcode;
  const data = `0x${initHex}${args.slice(2)}`;

  const account = privateKeyToAccount(pk as `0x${string}`);
  const publicClient = createPublicClient({ chain: EC_CHAIN, transport: http(EC_RPC_URL) });
  const walletClient = createWalletClient({ account, chain: EC_CHAIN, transport: http(EC_RPC_URL) });

  const balance = await publicClient.getBalance({ address: account.address });
  const gasPrice = await publicClient.getGasPrice();
  console.log(`deployer=${account.address}`);
  console.log(`balance=${(BigInt(balance) / 10n ** 18n).toString()} STT`);
  console.log(`gasPrice=${gasPrice} gas=${data.length / 2} bytes initcode`);
  console.log(`maxGasAffordable=${(balance / gasPrice).toString()}`);

  const affordable = balance / gasPrice;
  const gasLimit = affordable > 30_000_000n ? 30_000_000n : affordable;

  console.log(`broadcasting create with gasLimit=${gasLimit.toString()}...`);
  const hash = await walletClient.sendTransaction({ data, gas: gasLimit });
  console.log(`tx=${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    console.error("DEPLOY FAILED (status!=success)", receipt);
    process.exit(1);
  }
  console.log(`DREAMDUEL ROUND ESCROW DEPLOYED at: ${receipt.contractAddress}`);
  console.log(`gasUsed=${receipt.gasUsed}`);

  // Record the address for the app + wiring.
  const cfgPath = path.resolve(process.cwd(), "src/lib/ec/config.ts");
  let cfg = fs.readFileSync(cfgPath, "utf8");
  const old = cfg.match(/export const ROUND_ESCROW_ADDRESS = "0x[0-9a-fA-F]{40}"/)?.[0];
  if (old) {
    cfg = cfg.replace(old, `export const ROUND_ESCROW_ADDRESS = "${receipt.contractAddress}"`);
    fs.writeFileSync(cfgPath, cfg);
    console.log("updated ROUND_ESCROW_ADDRESS in src/lib/ec/config.ts");
  } else {
    console.log("NOTE: ROUND_ESCROW_ADDRESS const not found in config.ts — add it manually:");
    console.log(`  export const ROUND_ESCROW_ADDRESS = "${receipt.contractAddress}";`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
