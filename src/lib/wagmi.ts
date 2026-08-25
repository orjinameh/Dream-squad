import { http, createConfig } from "wagmi";
import { injected, safe } from "wagmi/connectors";
import { SOMNIA_CHAIN } from "./config";

export const wagmiConfig = createConfig({
  chains: [SOMNIA_CHAIN],
  connectors: [
    injected({ shimDisconnect: true }),
    safe(),
  ],
  transports: {
    [SOMNIA_CHAIN.id]: http("https://dream-rpc.somnia.network"),
  },
});
