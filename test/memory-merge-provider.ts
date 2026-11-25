import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Offline provider for a detached project store-merge pass: synthetic notes only, no network.
export default function memoryMergeTestProvider(pi: ExtensionAPI): void {
  pi.registerProvider("memory-merge-test", {
    api: "memory-merge-test-api",
    baseUrl: "https://synthetic.invalid",
    apiKey: "synthetic-not-a-secret",
    models: [{
      id: "scripted",
      name: "Scripted store merge",
      reasoning: false,
      input: ["text"],
      contextWindow: 128000,
      maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const results = context.messages.filter((message) => message.role === "toolResult");
      const task = JSON.stringify(context.messages.filter((message) => message.role === "user").map((message) => message.content));
      appendFileSync(process.env.PI_MEMORY_TEST_TRACE!, JSON.stringify({ cwd: process.cwd(), results: results.length }) + "\n");
      assert.match(task, /MEMORY STORE CONSOLIDATION \(MERGE\)/);

      const legacyFile = process.env.PI_MEMORY_TEST_LEGACY_FILE!;
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        model: model.id,
        provider: model.provider,
        timestamp: Date.now(),
        content: [],
        stopReason: "stop",
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const calls: ToolCall[] = [];
      if (results.length === 0) {
        calls.push({ type: "toolCall", id: "read-legacy", name: "read", arguments: { path: legacyFile } });
        calls.push({ type: "toolCall", id: "read-index", name: "memory_read", arguments: { scope: "project", path: "MEMORY.md" } });
        calls.push({
          type: "toolCall",
          id: "refuse-global",
          name: "memory_write",
          arguments: { scope: "global", path: "leak.md", content: "# Must be refused\n", expectedHash: null },
        });
      } else if (results.length === 3) {
        const [legacyRead, indexRead, globalRefused] = results;
        assert.ok(!legacyRead!.isError, JSON.stringify(legacyRead));
        assert.ok(!indexRead!.isError, JSON.stringify(indexRead));
        assert.ok(globalRefused!.isError && /cannot access global memory/.test(JSON.stringify(globalRefused!.content)));
        const legacyText = JSON.stringify(legacyRead!.content);
        assert.match(legacyText, /WORKTREE_SYNTHETIC_LESSON/);
        const indexPayload = JSON.parse((indexRead!.content[0] as { text: string }).text) as { hash: string | null };
        calls.push({
          type: "toolCall",
          id: "write-merged-note",
          name: "memory_write",
          arguments: {
            scope: "project",
            path: "topics/merged.md",
            content: "# Merged lessons\n\nConsolidated WORKTREE_SYNTHETIC_LESSON from legacy worktree store.\n",
            expectedHash: null,
          },
        });
        calls.push({
          type: "toolCall",
          id: "update-index",
          name: "memory_write",
          arguments: {
            scope: "project",
            path: "MEMORY.md",
            content: "# Project memory\n\n- [Merged lessons](topics/merged.md)\n",
            expectedHash: indexPayload.hash,
          },
        });
      } else {
        assert.ok(results.every((result, index) => index === 2 || !result.isError), JSON.stringify(results.at(-1)));
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
        message.content.push({ type: "text", text: "Consolidated the synthetic worktree note into primary memory." });
        stream.push({ type: "start", partial: message });
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "Consolidated the synthetic worktree note into primary memory.", partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: "Consolidated the synthetic worktree note into primary memory.", partial: message });
        stream.push({ type: "done", reason: "stop", message });
      }
      stream.end();
      return stream;
    },
  });
}
