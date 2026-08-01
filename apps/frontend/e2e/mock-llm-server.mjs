import http from "node:http";

const host = "127.0.0.1";
const port = 3016;
const output = JSON.stringify({
  status: "completed",
  content: "Deterministic local response for the Capybara end-to-end test.",
});

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

  request.resume();
  response.writeHead(200, {
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream",
  });
  sendEvent(response, "response.created", {
    type: "response.created",
    response: { model: "capybara-e2e", status: "in_progress" },
  });

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

server.listen(port, host);

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
