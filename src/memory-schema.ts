import { Type, type Static } from "typebox";

/** Project memory is isolated; global memory is explicitly shared across projects. */
export type MemoryScope = "project" | "global";

/** Markdown writes require an exact previous content hash, or null for create-only writes. */
export const memoryWriteSchema = Type.Object({
  action: Type.Optional(Type.Enum(["upsert", "archive"])),
  path: Type.String({ minLength: 1, maxLength: 240, description: "Relative Markdown path, such as MEMORY.md or topics/testing.md. No hidden components or traversal." }),
  content: Type.Optional(Type.String({ maxLength: 65536, description: "Complete Markdown content for upsert; omit for archive. At most 64 KiB UTF-8. MEMORY.md is limited to 8 KiB and 200 lines." })),
  expectedHash: Type.Union([Type.String({ pattern: "^[a-f0-9]{64}$" }), Type.Null()]),
  scope: Type.Optional(Type.Enum(["project", "global"])),
}, { additionalProperties: false });

/** Memory write tool input uses complete Markdown for upsert and omits content for archive. */
export type MemoryWriteInput = Static<typeof memoryWriteSchema>;
