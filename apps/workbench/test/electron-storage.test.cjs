const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ensureProjectStorage } = require("../electron/project-storage.cjs");
const { ensureSystemStorage, migrateLegacyProjectIndex, writeSystemCredentials, writeSystemModelSettings } = require("../electron/system-storage.cjs");

test("system storage keeps configuration, credentials, project index, and logs under the user home", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "capybara-system-"));
  const storage = ensureSystemStorage({ homeDirectory: home, env: { LLM_MODEL: "test-model" } });
  writeSystemCredentials(storage.credentialsFile, "system-test-key");
  assert.equal(storage.root, path.join(home, ".capybara"));
  assert.equal(fs.existsSync(storage.configFile), true);
  assert.equal(fs.existsSync(storage.credentialsFile), true);
  assert.equal(fs.existsSync(storage.projectsFile), true);
  assert.equal(fs.existsSync(storage.logsDirectory), true);
  assert.equal(storage.runtimeEnv.LLM_MODEL, "test-model");
  const withCredentials = ensureSystemStorage({ homeDirectory: home, env: {} });
  assert.equal(withCredentials.runtimeEnv.LLM_API_KEY, "system-test-key");
  const credentials = JSON.parse(fs.readFileSync(storage.credentialsFile, "utf8"));
  assert.equal(credentials.llm.apiKey, "system-test-key");
});

test("project storage creates the project .capybara boundary", () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "capybara-project-"));
  const storage = ensureProjectStorage(projectPath);
  assert.equal(fs.existsSync(storage.capybaraRoot), true);
  assert.equal(fs.existsSync(storage.applicationsDirectory), true);
  assert.equal(fs.existsSync(storage.contextDirectory), true);
  assert.equal(fs.existsSync(storage.contextFile), true);
  assert.equal(storage.sessionsFile, path.join(projectPath, ".capybara", "sessions.sqlite"));
});

test("system storage migrates an existing Electron project index once", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capybara-system-migration-"));
  const storage = ensureSystemStorage({ homeDirectory: root, env: {} });
  const legacy = path.join(root, "legacy-projects.json");
  fs.writeFileSync(legacy, JSON.stringify([{ ref: "directory:1", selectedPath: root, projectId: "project:1", displayName: "demo", isEmpty: true }]), "utf8");
  assert.equal(migrateLegacyProjectIndex(storage.projectsFile, legacy), true);
  assert.equal(JSON.parse(fs.readFileSync(storage.projectsFile, "utf8"))[0].projectId, "project:1");
  assert.equal(migrateLegacyProjectIndex(storage.projectsFile, legacy), false);
});

test('global model edits persist without putting credentials in config or dropping unrelated settings', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-model-config-'));
  const storage = ensureSystemStorage({homeDirectory:home,env:{}});
  fs.writeFileSync(storage.credentialsFile, JSON.stringify({version:1, llm:{apiKey:'old-test-key'}, anotherProvider:{configured:true}}));
  const input = {provider:'deepseek',model:'example-model',base_url:'https://api.example.com/v1',protocol:'chat-completions',api_key:'new-test-key'};
  writeSystemModelSettings(storage,input);
  const fresh = ensureSystemStorage({homeDirectory:home,env:{}});
  assert.equal(fresh.runtimeEnv.LLM_MODEL, 'example-model');
  assert.equal(fresh.runtimeEnv.LLM_API_KEY, 'new-test-key');
  assert.equal(JSON.parse(fs.readFileSync(storage.credentialsFile)).anotherProvider.configured, true);
  assert.doesNotMatch(fs.readFileSync(storage.configFile,'utf8'), /test-key/);
  writeSystemModelSettings(storage,{...input,api_key:undefined,model:'next-model'});
  assert.equal(ensureSystemStorage({homeDirectory:home,env:{}}).runtimeEnv.LLM_API_KEY, 'new-test-key');
  assert.throws(()=>writeSystemModelSettings(storage,{...input,base_url:'https://user:password@example.com'}), /without embedded credentials/);
  assert.equal(ensureSystemStorage({homeDirectory:home,env:{}}).runtimeEnv.LLM_MODEL, 'next-model');
});
