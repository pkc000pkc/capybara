import { defineHook } from "@capybara/sdk";

export default defineHook({
  name: "context-compression",
  description: "Summarize older LLM messages and retain a compact recent working set.",
  enabled: true,

  trigger({ status, changed }) {
    return status.run.status === "completed"
      && status.context.utilization >= 0.72
      && status.messageCount > 10
      && changed.has("builtin.sys_message");
  },

  schedule: {
    priority: 100,
    timeoutMs: 30000,
    onError: "continue",
  },

  permissions: {
    llm: "project",
    variables: "patch",
    messages: "replace",
  },

  async run({ llm, messages, variables, logger }) {
    const system = messages[0]?.role === "system" ? messages[0] : undefined;
    const conversation = system ? messages.slice(1) : messages;
    const recent = conversation.slice(-6);
    const earlier = conversation.slice(0, -6);

    if (earlier.length === 0) {
      return { metadata: { skipped: "no older messages" } };
    }

    const response = await llm.responses.create({
      model: llm.defaultModel,
      max_output_tokens: 1200,
      input: [
        {
          role: "system",
          content: "Compress the earlier agent conversation into a durable working summary. Preserve user intent, decisions, constraints, file paths, tool findings, unresolved work, failures, and exact identifiers. Remove repetition and conversational filler. Return only the summary text.",
        },
        {
          role: "user",
          content: JSON.stringify({
            previous_summary: variables.context.history_summary,
            messages: earlier,
          }),
        },
      ],
    });

    logger.info("context compressed", {
      removedMessages: earlier.length,
      retainedMessages: recent.length,
    });

    return {
      patches: [{
        op: "replace",
        path: "/context/history_summary",
        value: response.output_text,
      }],
      messages: [...(system ? [system] : []), ...recent],
      metadata: {
        removedMessages: earlier.length,
        retainedMessages: recent.length,
      },
    };
  },
});
