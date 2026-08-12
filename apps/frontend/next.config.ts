import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  ...(process.env.CAPYBARA_NEXT_DIST_DIR
    ? { distDir: process.env.CAPYBARA_NEXT_DIST_DIR }
    : {}),
};

export default nextConfig;
