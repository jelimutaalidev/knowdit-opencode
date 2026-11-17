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
  dataset_prepare: {
    type: "object",
    properties: {
      sourceRoot: { type: "string", description: "Dataset root (defaults to ~/c4-data/out_train)" },
      localIds: {
        type: "array",
        items: { type: "number" },
        description: "Local contest ids (defaults to the approved 12-contest batch)",
      },
    },
    additionalProperties: false,
  },
  kg_build: {
    type: "object",
    properties: {
      c4Ids: {
        type: "array",
        items: { type: "number" },
        description: "C4 contest ids to build (defaults to every contest in the manifest)",
      },
      force: {
        type: "boolean",
        description: "Reset and rebuild these contests; rejected once merge rows exist",
      },
      resetAll: { type: "boolean", description: "Clear the KG and journal before building" },
    },
    additionalProperties: false,
  },
  kg_status: { type: "object", additionalProperties: false },
  kg_query: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["semantic", "finding", "link"] },
      q: { type: "string", description: "Substring matched against the row's text fields" },
      category: {
        type: "string",
        description: "DeFi category for semantics, vulnerability category for findings",
      },
      severity: { type: "string", enum: ["High", "Medium", "Low"] },
      strength: { type: "string", enum: ["High", "Medium", "Low"] },
      findingId: { type: "number" },
      semanticId: { type: "number" },
      findingSeverity: { type: "string", enum: ["High", "Medium", "Low"] },
      canonicalOnly: { type: "boolean", description: "Exclude rows folded into a canonical" },
      unlinkedOnly: { type: "boolean", description: "Only semantics with no finding link" },
      limit: { type: "number", minimum: 1, maximum: 500 },
    },
    required: ["kind"],
    additionalProperties: false,
  },
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
