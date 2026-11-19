import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Both conditions may read synthetic ledger exports, not arbitrary host files. */
export default function installLedgerReadGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "read") return;
    const path = "path" in event.input && typeof event.input.path === "string" ? event.input.path : "";
    const allowed = Array.from({ length: 10 }, (_, index) =>
      resolve(ctx.cwd, `ledger-${String(index + 1).padStart(2, "0")}.csv`));
    if (!allowed.includes(resolve(ctx.cwd, path))) {
      return { block: true, reason: "The ledger evaluation only permits reading its synthetic CSV exports." };
    }
  });
}
