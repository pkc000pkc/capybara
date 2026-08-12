import http from "node:http";

const host = "127.0.0.1";
const port = Number(process.env.CAPYBARA_E2E_MODEL_PORT ?? 3016);
const output = JSON.stringify({
  status: "completed",
  content: "Deterministic local response for the Capybara end-to-end test.",
});
const retryAttempts = new Map();

function sendEvent(response, event, data) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"ok"}');
    return;
  }

  if (request.method !== "POST" || request.url !== "/v1/responses") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"error":"not found"}');
    return;
  }

  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      payload = {};
    }
    const input = Array.isArray(payload.input) ? payload.input : [];
    const lastInput = input.at(-1);
    const uninstallMarker = body.includes("E2E_REQUEST_SKILL_UNINSTALL");

    if (body.includes("E2E_RETRY_THEN_SUCCEED")) {
      const attempt = (retryAttempts.get(body) ?? 0) + 1;
      retryAttempts.set(body, attempt);
      if (attempt <= 2) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end('{"error":{"code":"e2e_retryable","message":"E2E retryable model failure"}}');
        return;
      }
      retryAttempts.delete(body);
    }

    if (body.includes("E2E_FORCE_MODEL_ERROR")) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end('{"error":{"code":"e2e_model_unavailable","message":"E2E forced model transport failure"}}');
      return;
    }

    response.writeHead(200, {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream",
    });
    sendEvent(response, "response.created", {
      type: "response.created",
      response: { model: "capybara-e2e", status: "in_progress" },
    });

    if (uninstallMarker && lastInput?.type !== "function_call_output") {
      const callId = `e2e-uninstall-${Date.now()}`;
      sendEvent(response, "response.completed", {
        type: "response.completed",
        response: {
          model: "capybara-e2e",
          status: "completed",
          output: [{
            type: "function_call",
            id: callId,
            call_id: callId,
            name: "request_skill_uninstall",
            arguments: JSON.stringify({ skill_id: "project-files" }),
          }],
          usage: { input_tokens: 8, output_tokens: 8, total_tokens: 16 },
        },
      });
      response.end();
      return;
    }

    const timer = setTimeout(() => {
      if (response.destroyed || response.writableEnded) return;
      sendEvent(response, "response.output_text.delta", {
        type: "response.output_text.delta",
        delta: output,
      });
      sendEvent(response, "response.completed", {
        type: "response.completed",
        response: {
          model: "capybara-e2e",
          status: "completed",
          output: [{
            type: "message",
            content: [{ type: "output_text", text: output }],
          }],
          usage: { input_tokens: 8, output_tokens: 8, total_tokens: 16 },
        },
      });
      response.end();
    }, 2_000);

    response.on("close", () => clearTimeout(timer));
  });
});

server.listen(port, host);

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
