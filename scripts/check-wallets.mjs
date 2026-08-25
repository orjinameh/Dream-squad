import { createPublicClient, http, formatUnits } from "viem";

const RPC = "https://dream-rpc.somnia.network";
const client = createPublicClient({ transport: http(RPC) });

const OPERATOR = "0xdd68998C099f7570E59019ae35469E5603cEDA11";
const FUND    = "0x9196d7670eea0CB723af11465d4285541a2eA86a";

const [opBal, fundBal] = await Promise.all([
  client.getBalance({ address: OPERATOR }),
  client.getBalance({ address: FUND }),
]);

console.log(`Operator (${OPERATOR.slice(0,8)}...): ${formatUnits(opBal, 18)} STT`);
console.log(`Fund     (${FUND.slice(0,8)}...): ${formatUnits(fundBal, 18)} STT`);
console.log(`Operator warm: ${opBal > 50000000000000000n ? "YES (>0.05 STT)" : "NO - NEEDS TOP-UP"}`);
