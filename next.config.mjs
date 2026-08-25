import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const webpack = require("next/dist/compiled/webpack/webpack-lib.js");

/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config) => {
    config.plugins.push(
      new webpack.IgnorePlugin({ resourceRegExp: /^@coinbase\/cdp-sdk/ }),
      new webpack.IgnorePlugin({ resourceRegExp: /^@base-org\/account/ }),
      new webpack.IgnorePlugin({ resourceRegExp: /^@x402/ }),
    );
    return config;
  },
};

export default nextConfig;
