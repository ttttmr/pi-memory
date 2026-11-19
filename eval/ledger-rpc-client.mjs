import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

/** JSONL RPC with an exact environment allowlist and no raw child output to the terminal. */
export class LedgerEvalRpcClient {
  #child;
  #closed;
  #failure;
  #pending = new Map();
  #listeners = new Set();
  #stderr = "";
  #sequence = 0;

  constructor({ cliPath, cwd, provider, model, args, env }) {
    this.options = { cliPath, cwd, provider, model, args, env };
  }

  start() {
    const { cliPath, cwd, provider, model, args, env } = this.options;
    const child = this.#child = spawn(process.execPath, [cliPath, "--mode", "rpc", "--provider", provider, "--model", model, ...args],
      { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.#closed = once(child, "close").catch(() => {});
    child.on("error", (error) => this.#fail(error));
    child.on("exit", (code, signal) => this.#fail(new Error(`Pi RPC exited (${code ?? signal}). ${this.#stderr}`)));
    child.stdin.on("error", (error) => this.#fail(error));
    child.stderr.setEncoding("utf8").on("data", (chunk) => { this.#stderr = (this.#stderr + chunk).slice(-4096); });
    let tail = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      const lines = (tail + chunk).split("\n");
      tail = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          this.#fail(new Error("Pi RPC stdout contained an invalid JSONL record."));
          return;
        }
        if (event.type === "response") {
          const pending = this.#pending.get(event.id);
          if (event.success) pending?.resolve(event.data);
          else pending?.reject(new Error(`Pi RPC ${event.command} failed: ${event.error}`));
        } else if (event.type === "extension_error" || event.type === "extension_ui_request") {
          this.#fail(new Error(`Unexpected Pi RPC ${event.type}: ${event.error ?? event.method ?? "unknown"}`));
        } else {
          for (const listener of this.#listeners) listener(event);
        }
      }
    });
  }

  #fail(error) {
    this.#failure ??= error;
    for (const waiting of this.#pending.values()) waiting.reject(error);
  }

  #awaitRpc(id, ms, start) {
    if (this.#failure) return Promise.reject(this.#failure);
    let timer;
    return new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Pi RPC deadline exceeded for ${id}.`)), ms);
      this.#pending.set(id, { resolve, reject });
      start(resolve);
    }).finally(() => {
      clearTimeout(timer);
      this.#pending.delete(id);
    });
  }

  request(type, fields = {}) {
    const id = `${type}-${++this.#sequence}`;
    return this.#awaitRpc(id, 15_000, () => {
      this.#child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    });
  }

  onEvent(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async promptAndWait(message, timeoutMs) {
    const events = [];
    let unsubscribe;
    const settlementId = `agent_settled-${++this.#sequence}`;
    const settled = this.#awaitRpc(settlementId, timeoutMs, (resolve) => {
      unsubscribe = this.onEvent((event) => {
        // Ignore streaming deltas and low-level duplicate messages.
        if (["tool_execution_start", "tool_execution_end", "message_end", "agent_settled"].includes(event.type)) events.push(event);
        if (event.type === "agent_settled") resolve(events);
      });
    });
    try {
      const [, result] = await Promise.all([
        this.request("prompt", { message }).then(({ disposition }) => {
          if (disposition !== "started") throw new Error(`Pi RPC prompt unexpectedly ${disposition}.`);
        }),
        settled,
      ]);
      return result;
    } finally {
      unsubscribe?.();
      // On prompt rejection, cancel its otherwise orphaned settlement deadline.
      this.#pending.get(settlementId)?.resolve(events);
    }
  }

  async stop() {
    if (!this.#child) return;
    this.#child.stdin.end();
    const exited = await Promise.race([this.#closed.then(() => true), delay(2_000, false, { ref: false })]);
    if (!exited) this.#child.kill("SIGKILL");
    await this.#closed;
  }
}
