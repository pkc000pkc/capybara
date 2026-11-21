const fs = require("node:fs/promises");
const path = require("node:path");

/**
 * Inspect only the selected directory's immediate entries. This deliberately
 * does not recurse or read file contents; the result is safe to pass to a
 * renderer and contains no local path.
 */
async function inspectDirectory(directoryPath, readdir = fs.readdir) {
  const resolvedPath = path.resolve(directoryPath);
  const entries = await readdir(resolvedPath, { withFileTypes: true });
  const projectEntries = entries.filter((entry) => entry.name !== ".capybara");
  return {
    displayName: path.basename(resolvedPath) || "本机项目",
    isEmpty: projectEntries.length === 0,
  };
}

module.exports = { inspectDirectory };
