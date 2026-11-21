const assert = require("node:assert/strict");
const test = require("node:test");
const { createApplicationHostAdapter, createApplicationRuntimeHostAdapter } = require("../electron/application-host-adapter.cjs");

test("ApplicationHostAdapter maps runtime actions to the process supervisor and keeps call identity", async () => {
  const calls = [];
  const adapter = createApplicationHostAdapter({
    supervisor: {
      async start(input) { calls.push(["start", input]); return { status: "running", instanceId: "instance:1" }; },
      async stop(input) { calls.push(["stop", input]); return { status: "stopped", instanceId: input.instanceId }; },
      async restart(input) { calls.push(["restart", input]); return { status: "running", instanceId: "instance:2" }; },
      async healthCheck(input) { calls.push(["health", input]); return { status: "running", instanceId: input.instanceId }; },
    },
  });
  const result = await adapter({ action: "start", projectPath: "C:/project", projectId: "project:1", callId: "call:1", turnId: "turn:1", stepId: "step:1" });
  assert.equal(result.ok, true);
  assert.equal(result.name, "manage_application");
  assert.equal(result.id, "call:1");
  assert.equal(result.output.status, "running");
  assert.equal(calls[0][0], "start");
  const failed = await adapter({ action: "unknown", callId: "call:2" });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, "APPLICATION_HOST_FAILED");
});

test("ApplicationRuntimeHostAdapter exposes lifecycle methods for the logical runtime service", async () => {
  const host = createApplicationRuntimeHostAdapter({
    supervisor: {
      async start() { return { status: "running", instanceId: "instance:1", versionId: "v1" }; },
      async stop() { return { status: "stopped", instanceId: "instance:1", versionId: "v1" }; },
      async healthCheck() { return { status: "running", health: { path: "/health" } }; },
      async update() { return { status: "running", versionId: "v2" }; },
      async rollback() { return { status: "running", versionId: "v1" }; },
    },
  });
  assert.equal((await host.start({ projectId: "project:1", appId: "app", versionId: "v1", runId: "run" })).ok, true);
  assert.equal((await host.stop({ projectId: "project:1", appId: "app", versionId: "v1", runId: "run" })).status, "stopped");
  assert.equal((await host.healthCheck({ projectId: "project:1", appId: "app", versionId: "v1", runId: "run" })).ok, true);
});
