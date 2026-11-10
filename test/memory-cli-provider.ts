import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Test-only, in-process provider: no HTTP client, credentials or real model invocation.
export default function memoryCliTestProvider(pi: ExtensionAPI): void {
  let finishBusy: (() => void) | undefined;
  pi.on("input", (event) => {
    if (event.text.startsWith("Remember this for future turns and sessions") && finishBusy) {
      // Let the host queue the follow-up before completing this synthetic in-flight response.
      setImmediate(finishBusy);
    }
    return { action: "continue" };
  });
  pi.registerProvider("memory-cli-test", {
    api: "memory-cli-test-api", baseUrl: "https://synthetic.invalid", apiKey: "synthetic-not-a-secret",
    models: [{ id: "scripted", name: "Scripted memory test", reasoning: false, input: ["text"],
      contextWindow: 32000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const lastUser = context.messages.findLast((message) => message.role === "user");
      const prompt = typeof lastUser?.content === "string" ? lastUser.content :
        lastUser?.content.map((block) => block.type === "text" ? block.text : "").join("\n");
      const results = context.messages.filter((message) => message.role === "toolResult");
      const trace = process.env.PI_MEMORY_TEST_TRACE!;
      appendFileSync(trace, JSON.stringify({ prompt, results: results.length }) + "\n");
      const message: AssistantMessage = { role: "assistant", api: model.api, model: model.id,
        provider: model.provider, timestamp: Date.now(), content: [], stopReason: "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: "start", partial: message });
      if (prompt === "SYNTHETIC_BUSY_TASK") {
        addText("SYNTHETIC_BUSY_FINISHED");
        finishBusy = () => {
          finishBusy = undefined;
          stream.push({ type: "done", reason: "stop", message });
          stream.end();
        };
        return stream;
      }
      if (prompt?.startsWith("Remember this for future turns and sessions")) {
        if (!results.length) {
          message.stopReason = "toolUse";
          for (const [path, content] of [["preferences.md", "Prefer concise fixture responses."],
            ["MEMORY.md", "# Memory\n- [Response preference](preferences.md)\n"]]) {
            const index = message.content.length;
            message.content.push({ type: "toolCall", id: `write-${index}`, name: "memory_write", arguments: {} });
            stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
            const toolCall = { type: "toolCall" as const, id: `write-${index}`, name: "memory_write",
              arguments: { path, content, expectedHash: null } };
            message.content[index] = toolCall;
            stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: message });
          }
        } else {
          assert.equal(results.length, 2);
          assert.ok(results.every((result) => !result.isError));
          addText("SYNTHETIC_MEMORY_SAVED");
        }
      } else {
        assert.ok(JSON.stringify(context.messages).includes("preferences.md"), "Fresh session receives the persisted index");
        addText("SYNTHETIC_INDEX_RECALLED");
      }
      stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
      stream.end();
      return stream;

      function addText(text: string) {
        message.content.push({ type: "text", text: "" });
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        message.content[0] = { type: "text", text };
        stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
      }
    },
  });
}
