import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

/** Synthetic Markdown never references real user sessions or evidence. */
export const memoryTestContent = "# Synthetic memory\n\nUse the installed API reference when writing extensions.\n";

/** Temporary memory test directories are removed after each test. */
export async function createMemoryTestDirectory(ctx: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-memory-test-"));
  ctx.after(() => rm(directory, { recursive: true, force: true }));
  return realpath(directory);
}
