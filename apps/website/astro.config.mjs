import { defineConfig } from "astro/config";

const repository = process.env.GITHUB_REPOSITORY?.split("/")[1] ?? "capybara";
const owner = process.env.GITHUB_REPOSITORY_OWNER ?? "pkc000pkc";
const isGitHubBuild = process.env.GITHUB_ACTIONS === "true";
const isUserSite = repository.endsWith(".github.io");

export default defineConfig({
  output: "static",
  site:
    process.env.PUBLIC_SITE_URL ??
    (isGitHubBuild ? `https://${owner}.github.io` : "http://localhost:4321"),
  base: isGitHubBuild && !isUserSite ? `/${repository}` : "/",
  trailingSlash: "always",
});
