import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Offline provider for detached CLI acceptance: all evidence is synthetic and no network is used.
export default function memoryDreamTestProvider(pi: ExtensionAPI): void {
  pi.registerProvider("memory-dream-test", {
    api: "memory-dream-test-api", baseUrl: "https://synthetic.invalid", apiKey: "synthetic-not-a-secret",
    models: [{ id: "scripted", name: "Scripted detached dreaming", reasoning: false, input: ["text"],
      contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const results = context.messages.filter((message) => message.role === "toolResult");
      const user = context.messages.find((message) => message.role === "user" && JSON.stringify(message.content).includes("assigned batch"));
      const task = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content);
      const tools = pi.getAllTools().map((tool) => tool.name);
      appendFileSync(process.env.PI_MEMORY_TEST_TRACE!, JSON.stringify({ results: results.length, tools }) + "\n");
      assert.match(task ?? "", /assigned batch/);
      assert.match(task ?? "", /synthetic-source-session/);
      assert.match(task ?? "", /Hard wall-clock deadline/);
      for (const name of ["bash", "read", "edit", "write"]) assert.ok(tools.includes(name));
      assert.ok(results.every((result) => !result.isError), JSON.stringify(results.at(-1)));
      const message: AssistantMessage = { role: "assistant", api: model.api, model: model.id,
        provider: model.provider, timestamp: Date.now(), content: [], stopReason: "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const calls: ToolCall[] = [];
      if (results.length < 70) {
        calls.push({ type: "toolCall", id: `read-${results.length}`, name: "read", arguments: { path: process.env.PI_MEMORY_TEST_SOURCE! } });
        calls.push({ type: "toolCall", id: `search-${results.length}`, name: "memory_search", arguments: { scope: "project" } });
      } else if (results.length === 70) {
        assert.match(JSON.stringify(results), /SYNTHETIC_VERIFIED_FEEDBACK/);
        calls.push({ type: "toolCall", id: "note-write", name: "memory_write",
          arguments: { path: "lessons.md", content: "# Synthetic lesson\nSYNTHETIC_VERIFIED_FEEDBACK. Source: synthetic-source-session:user-0", expectedHash: null } });
        calls.push({ type: "toolCall", id: "index-write", name: "memory_write",
          arguments: { path: "MEMORY.md", content: "# Project memory\n- [Synthetic lesson](lessons.md)\n", expectedHash: null } });
      }
      if (calls.length) {
        message.stopReason = "toolUse";
        stream.push({ type: "start", partial: message });
        for (const toolCall of calls) {
          const index = message.content.length;
          message.content.push(toolCall);
          stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
          stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: message });
        }
        stream.push({ type: "done", reason: "toolUse", message });
      } else {
        message.content.push({ type: "text", text: "Inspected synthetic session and saved its confirmed lesson and index." });
        stream.push({ type: "start", partial: message });
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "Synthetic dreaming finished.", partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: "Synthetic dreaming finished.", partial: message });
        stream.push({ type: "done", reason: "stop", message });
      }
      stream.end();
      return stream;
    },
  });
}
