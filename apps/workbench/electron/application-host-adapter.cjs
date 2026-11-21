function createApplicationRuntimeHostAdapter({ supervisor } = {}) {
  if (!supervisor) throw new Error("application supervisor is required");

  async function execute(input) {
    const action = String(input?.action || "start");
    if (action === "start") return supervisor.start(input);
    if (action === "stop") return supervisor.stop(input);
    if (action === "restart") return supervisor.restart(input);
    if (action === "health" || action === "health_check") return supervisor.healthCheck(input);
    if (action === "update") return supervisor.update(input);
    if (action === "rollback") return supervisor.rollback(input);
    throw new Error(`unsupported application action: ${action}`);
  }

  return {
    start: (input) => execute({ ...input, action: "start" }).then((output) => ({ ok: true, ...output })),
    stop: (input) => execute({ ...input, action: "stop" }).then((output) => ({ ok: true, ...output })),
    healthCheck: (input) => execute({ ...input, action: "health_check" }).then((output) => ({ ok: output.status === "running", ...output })),
    update: (input) => execute({ ...input, action: "update" }).then((output) => ({ ok: true, ...output })),
    rollback: (input) => execute({ ...input, action: "rollback" }).then((output) => ({ ok: true, ...output })),
  };
}

function createApplicationHostAdapter({ supervisor, runtimeHost: suppliedRuntimeHost } = {}) {
  const runtimeHost = suppliedRuntimeHost || createApplicationRuntimeHostAdapter({ supervisor });
  return async function applicationHostAdapter(input) {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    try {
      const action = String(input?.action || "start");
      let output = await (action === "start" ? runtimeHost.start(input) : action === "stop" ? runtimeHost.stop(input) : action === "health" || action === "health_check" ? runtimeHost.healthCheck(input) : action === "update" ? runtimeHost.update(input) : action === "rollback" ? runtimeHost.rollback(input) : Promise.reject(new Error(`unsupported application action: ${action}`)));
      const completedAt = new Date().toISOString();
      return { id: input.callId, name: "manage_application", ok: true, output, startedAt, completedAt, durationMs: Date.now() - startedMs };
    } catch (error) {
      const completedAt = new Date().toISOString();
      return {
        id: input.callId,
        name: "manage_application",
        ok: false,
        error: { code: "APPLICATION_HOST_FAILED", message: error instanceof Error ? error.message : String(error) },
        startedAt,
        completedAt,
        durationMs: Date.now() - startedMs,
      };
    }
  };
}

module.exports = { createApplicationHostAdapter, createApplicationRuntimeHostAdapter };
