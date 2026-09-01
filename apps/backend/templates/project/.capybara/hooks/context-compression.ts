import { defineHook } from "@capybara-agent/sdk";

function cacheChanged(changed) {
  return [...changed].some((path) => path === "builtin.cache" || path.startsWith("builtin.cache."));
}

function recentCacheMessages(messages, maxTokens) {
  let start = Math.max(0, messages.length - 4);
  while (start > 0 && messages[start]?.role === "tool") start -= 1;
  const recent = messages.slice(start);
  return JSON.stringify(recent).length / 4 <= maxTokens * 0.35 ? recent : [];
}

export default defineHook({
  name: "context-compression",
  description: "Compress only the runtime Cache when the next model input exceeds its configured limit.",
  enabled: true,

  trigger({ status, changed, variables }) {
    const cache = variables.builtin.cache;
    return status.run.status === "completed"
      && status.context.usedTokens > status.context.maxTokens
      && cacheChanged(changed)
      && (cache.summary.length > 0 || cache.messages.length > 0);
  },

  schedule: {
    priority: 9000,
    timeoutMs: 30000,
    onError: "continue",
  },

  permissions: {
    llm: "project",
    variables: "patch",
  },

  async run({ llm, status, variables, logger }) {
    const cache = variables.builtin.cache;
    const recent = recentCacheMessages(cache.messages, status.context.maxTokens);
    const earlier = cache.messages.slice(0, cache.messages.length - recent.length);
    const sourceMessages = earlier.length > 0 ? earlier : cache.messages;
    const retainedMessages = earlier.length > 0 ? recent : [];

    const response = await llm.responses.create({
      model: llm.defaultModel,
      max_output_tokens: Math.max(128, Math.min(1200, Math.floor(status.context.maxTokens * 0.2))),
      input: [
        {
          role: "system",
          content: "Compress the runtime Cache into a durable working summary. Preserve user intent, decisions, constraints, exact identifiers, tool arguments and results, failures, verification evidence, and unresolved work. Remove repetition and conversational filler. Return only the summary text.",
        },
        {
          role: "user",
          content: JSON.stringify({
            previous_summary: cache.summary,
            cache_messages: sourceMessages,
          }),
        },
      ],
    });

    const summary = response.output_text.trim();
    if (!summary) throw new Error("Cache compression returned an empty summary");

    logger.info("runtime Cache compressed", {
      compressedMessages: sourceMessages.length,
      retainedMessages: retainedMessages.length,
    });

    return {
      patches: [{
        op: "replace",
        path: "/builtin/cache",
        value: {
          ...cache,
          summary,
          messages: retainedMessages,
          compression_count: cache.compression_count + 1,
          compressed_at: new Date().toISOString(),
        },
      }],
      metadata: {
        compressedMessages: sourceMessages.length,
        retainedMessages: retainedMessages.length,
      },
    };
  },
});
