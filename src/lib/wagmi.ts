import { http, createConfig } from "wagmi";
import { injected } from "wagmi/connectors";
import { SOMNIA_CHAIN } from "./config";

export const wagmiConfig = createConfig({
  chains: [SOMNIA_CHAIN],
  connectors: [
    injected({ shimDisconnect: true }),
  ],
  transports: {
    [SOMNIA_CHAIN.id]: http("https://dream-rpc.somnia.network"),
  },
});
