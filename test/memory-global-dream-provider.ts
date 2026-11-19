import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Offline provider for a detached global pass: synthetic notes only, no network.
export default function memoryGlobalDreamTestProvider(pi: ExtensionAPI): void {
  pi.registerProvider("memory-global-dream-test", {
    api: "memory-global-dream-test-api", baseUrl: "https://synthetic.invalid", apiKey: "synthetic-not-a-secret",
    models: [{ id: "scripted", name: "Scripted global dreaming", reasoning: false, input: ["text"],
      contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const results = context.messages.filter((message) => message.role === "toolResult");
      const task = JSON.stringify(context.messages.filter((message) => message.role === "user").map((message) => message.content));
      appendFileSync(process.env.PI_MEMORY_TEST_TRACE!, JSON.stringify({ cwd: process.cwd(), results: results.length }) + "\n");
      assert.match(task, /GLOBAL MEMORY MAINTENANCE/);
      assert.match(task, /tools\/dup\.md: 2 read\(s\)/);
      const message: AssistantMessage = { role: "assistant", api: model.api, model: model.id,
        provider: model.provider, timestamp: Date.now(), content: [], stopReason: "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const calls: ToolCall[] = [];
      if (results.length === 0) {
        calls.push({ type: "toolCall", id: "read-dup", name: "memory_read", arguments: { scope: "global", path: "tools/dup.md" } });
        calls.push({ type: "toolCall", id: "project-write", name: "memory_write",
          arguments: { path: "leak.md", content: "# Must not be written", expectedHash: null } });
      } else if (results.length === 2) {
        const [read, refused] = results;
        assert.ok(!read!.isError);
        assert.ok(refused!.isError && /cannot access project memory/.test(JSON.stringify(refused!.content)));
        const hash = JSON.parse((read!.content[0] as { text: string }).text).hash as string;
        calls.push({ type: "toolCall", id: "archive-dup", name: "memory_write",
          arguments: { scope: "global", action: "archive", path: "tools/dup.md", expectedHash: hash } });
      } else {
        assert.ok(results.every((result, index) => index === 1 || !result.isError), JSON.stringify(results.at(-1)));
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
        message.content.push({ type: "text", text: "Archived the synthetic duplicate global note." });
        stream.push({ type: "start", partial: message });
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "Archived the synthetic duplicate global note.", partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: "Archived the synthetic duplicate global note.", partial: message });
        stream.push({ type: "done", reason: "stop", message });
      }
      stream.end();
      return stream;
    },
  });
}
