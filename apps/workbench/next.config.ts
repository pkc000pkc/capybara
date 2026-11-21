import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  // Electron loads the exported entry through file://, so static assets must
  // resolve relative to out/index.html instead of the host filesystem root.
  assetPrefix: "./",
  images: { unoptimized: true },
  ...(process.env.CAPYBARA_WORKBENCH_DIST_DIR
    ? { distDir: process.env.CAPYBARA_WORKBENCH_DIST_DIR }
    : {}),
};

export default nextConfig;
