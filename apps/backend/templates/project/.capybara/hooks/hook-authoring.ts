import { defineHook } from "@capybara-agent/sdk";

const BLOCK_PATTERN = /^```capybara-hook name=([a-z][a-z0-9]*(?:-[a-z0-9]+)*)[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;

function latestAssistantMessage(messages) {
  return [...messages].reverse().find((message) => message.role === "assistant")?.content ?? "";
}

export default defineHook({
  name: "hook-authoring",
  description: "Install explicitly marked LLM-generated Hook files into the user Hook directory.",
  enabled: true,
  checkpoint: "after_loop",

  trigger({ messages }) {
    return latestAssistantMessage(messages).includes("```capybara-hook");
  },

  schedule: {
    priority: 10000,
    timeoutMs: 5000,
    onError: "continue",
  },

  permissions: {
    hooks: "write",
  },

  run({ messages }) {
    const content = latestAssistantMessage(messages);
    const markerCount = content.match(/```capybara-hook\b/g)?.length ?? 0;
    const hookFiles = [...content.matchAll(BLOCK_PATTERN)].map((match) => ({
      name: match[1],
      source: `${match[2].trim()}\n`,
    }));
    if (hookFiles.length === 0 || hookFiles.length !== markerCount) {
      throw new Error("Generated Hook blocks must use: ```capybara-hook name=<kebab-case-name>");
    }
    return { hookFiles };
  },
});
