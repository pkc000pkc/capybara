const fs = require("node:fs");
const path = require("node:path");

function writeJsonIfMissing(file, value) {
  if (fs.existsSync(file)) return;
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function ensureProjectStorage(projectPath) {
  const projectRoot = path.resolve(projectPath);
  const capybaraRoot = path.join(projectRoot, ".capybara");
  const applicationsDirectory = path.join(capybaraRoot, "applications");
  const contextDirectory = path.join(capybaraRoot, "context");
  const logsDirectory = path.join(capybaraRoot, "logs");
  fs.mkdirSync(applicationsDirectory, { recursive: true });
  fs.mkdirSync(contextDirectory, { recursive: true });
  fs.mkdirSync(logsDirectory, { recursive: true });
  writeJsonIfMissing(path.join(contextDirectory, "context.json"), {
    version: 1,
    documents: [],
    candidates: [],
    revisions: [],
  });
  return {
    projectRoot,
    capybaraRoot,
    applicationsDirectory,
    contextDirectory,
    contextFile: path.join(contextDirectory, "context.json"),
    logsDirectory,
    sessionsFile: path.join(capybaraRoot, "sessions.sqlite"),
  };
}

module.exports = { ensureProjectStorage };
