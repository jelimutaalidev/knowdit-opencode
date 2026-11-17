export type ToolHandler = (
  input: unknown,
  ctx: { progress?: (update: Record<string, unknown>) => Promise<void> },
) => Promise<{ content: string }>;

export type ToolEditor = {
  namespace(n: { name: string; description: string }): void;
  add(tool: {
    name: string;
    description: string;
    input: unknown;
    execute: ToolHandler;
  }): void;
};

export const TOOL_DESCRIPTIONS: Record<string, string> = {
  dataset_prepare: "Snapshot eligible C4 contests and write the dataset manifest.",
  kg_build: "Build or resume the KNOWDIT knowledge graph from the prepared dataset.",
  kg_status: "Report KG build progress and integrity status.",
  kg_query: "Query findings, semantics, or links in the knowledge graph.",
  kg_stats: "Report KG statistics in KNOWDIT's reference format.",
};

export const TOOL_SCHEMAS: Record<string, unknown> = {
  dataset_prepare: { type: "object", additionalProperties: false },
  kg_build: { type: "object", additionalProperties: false },
  kg_status: { type: "object", additionalProperties: false },
  kg_query: { type: "object", additionalProperties: false },
  kg_stats: { type: "object", additionalProperties: false },
};

export function registerKnowditTools(
  editor: ToolEditor,
  handlers: Record<string, ToolHandler>,
): void {
  editor.namespace({
    name: "knowdit",
    description: "KNOWDIT historical knowledge graph",
  });
  for (const [name, execute] of Object.entries(handlers)) {
    editor.add({
      name,
      description: TOOL_DESCRIPTIONS[name] ?? name,
      input: TOOL_SCHEMAS[name] ?? { type: "object" },
      execute,
    });
  }
}
