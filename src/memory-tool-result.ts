/** Return a complete JSON text result within the 50 KiB tool output budget. */
export function memoryToolResult(value: unknown) {
  const maxBytes = 50 * 1024;
  let text = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(text) > maxBytes) {
    if (!Array.isArray(value)) throw new Error("Memory tool result exceeds 50 KiB; request a smaller page");
    const results = [...value];
    do {
      results.pop();
      text = JSON.stringify({ results, outputTruncated: true, hint: "Request fewer results or a narrower query." }, null, 2);
    } while (Buffer.byteLength(text) > maxBytes && results.length);
  }
  return { content: [{ type: "text" as const, text }], details: {} };
}
