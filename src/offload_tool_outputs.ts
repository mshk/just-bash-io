import type { ToolSet } from "ai";
import type { Bash } from "just-bash";

/** Minimum size, in characters, before a tool result is offloaded to a file. */
export const DEFAULT_MIN_OFFLOAD_CHARACTERS = 800;

/** Number of leading lines kept in the preview returned to the model. */
export const DEFAULT_PREVIEW_LINES = 10;

/** Hard cap on preview length, in characters. */
export const DEFAULT_PREVIEW_MAX_CHARACTERS = 800;

export interface PreviewOptions {
  /** Leading lines to include. Defaults to {@link DEFAULT_PREVIEW_LINES}. */
  lines?: number;
  /** Cap on preview characters. Defaults to {@link DEFAULT_PREVIEW_MAX_CHARACTERS}. */
  maxCharacters?: number;
}

/** Result of turning an arbitrary tool result into text for the virtual filesystem. */
export interface SerializedToolResult {
  text: string;
  /** File extension without the leading dot, e.g. `json` or `txt`. */
  extension: string;
}

/** What the model receives instead of the full tool result. */
export interface OffloadedToolOutput {
  offloaded: true;
  /** Absolute path of the file inside the virtual filesystem. */
  path: string;
  characterCount: number;
  lineCount: number;
  /** Leading excerpt, so the model can see the shape of the data. */
  preview?: string;
  /** True when the preview covers only part of the file. */
  previewTruncated?: boolean;
  /** Instruction telling the model how to consume the file. */
  hint: string;
}

export interface OffloadToolOutputsOptions {
  /** Shell whose virtual filesystem receives the files. Use the one from `createBashTools`. */
  bash: Bash;
  /** Directory for offloaded files. Defaults to `<bash cwd>/data`. */
  directory?: string;
  /**
   * Results shorter than this stay inline, because a short answer is cheaper to
   * read directly than to route through a file. Defaults to
   * {@link DEFAULT_MIN_OFFLOAD_CHARACTERS}. Set to `0` to always offload.
   */
  minCharacters?: number;
  /** Preview settings, or `false` to return no excerpt at all. */
  preview?: PreviewOptions | false;
  /** Names of tools to wrap. Defaults to every tool in the set. */
  include?: string[];
  /** Names of tools to leave untouched. */
  exclude?: string[];
  /** Overrides the generated file name (without directory). */
  fileName?: (context: {
    toolName: string;
    /** 1-based counter, per tool name. */
    callCount: number;
    extension: string;
  }) => string;
  /**
   * Converts a tool result to text. Return `undefined` to fall back to the
   * built-in conversion (string as-is, MCP text content joined, anything else
   * JSON-stringified).
   */
  serialize?: (result: unknown, toolName: string) => SerializedToolResult | undefined;
  /** Called after a result has been written to the virtual filesystem. */
  onOffload?: (context: { toolName: string; path: string; characterCount: number }) => void;
}

/** MCP-style content array, as returned by `experimental_createMCPClient` tools. */
function extractMcpText(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || !("content" in result)) return undefined;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;

  const texts = content.flatMap((part) =>
    part && typeof part === "object" && (part as { type?: unknown }).type === "text" &&
    typeof (part as { text?: unknown }).text === "string"
      ? [(part as { text: string }).text]
      : []
  );

  return texts.length > 0 ? texts.join("\n") : undefined;
}

function isErrorResult(result: unknown): boolean {
  return (
    !!result &&
    typeof result === "object" &&
    "isError" in result &&
    (result as { isError?: unknown }).isError === true
  );
}

function defaultSerialize(result: unknown): SerializedToolResult {
  if (typeof result === "string") {
    return { text: result, extension: "txt" };
  }

  const mcpText = extractMcpText(result);
  if (mcpText !== undefined) {
    // MCP servers usually put JSON in a text part; keep the .json extension when
    // it parses so downstream `jq` usage is obvious to the model.
    try {
      JSON.parse(mcpText);
      return { text: mcpText, extension: "json" };
    } catch {
      return { text: mcpText, extension: "txt" };
    }
  }

  return { text: JSON.stringify(result, null, 2) ?? String(result), extension: "json" };
}

function sanitizeFileNamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_") || "tool";
}

function buildPreview(
  text: string,
  options: PreviewOptions | false
): { preview?: string; previewTruncated?: boolean } {
  if (options === false) return {};

  const lines = options?.lines ?? DEFAULT_PREVIEW_LINES;
  const maxCharacters = options?.maxCharacters ?? DEFAULT_PREVIEW_MAX_CHARACTERS;

  const head = text.split("\n").slice(0, lines).join("\n");
  const clipped = head.length > maxCharacters ? head.slice(0, maxCharacters) : head;

  return { preview: clipped, previewTruncated: clipped.length < text.length };
}

/**
 * Wraps a tool set so that large results are written to the virtual filesystem
 * instead of being returned to the model.
 *
 * This closes the *input* side of the loop: combined with the sink tool from
 * `createBashTools`, neither the fetched data nor the rendered output has to pass
 * through the model's context. The model only decides how to transform the file.
 *
 * Errors are never offloaded — the model has to see them to recover.
 */
export function offloadToolOutputs(
  tools: ToolSet,
  {
    bash,
    directory,
    minCharacters = DEFAULT_MIN_OFFLOAD_CHARACTERS,
    preview,
    include,
    exclude,
    fileName,
    serialize,
    onOffload,
  }: OffloadToolOutputsOptions
): ToolSet {
  const targetDirectory = directory ?? `${bash.getCwd()}/data`;
  const callCounts = new Map<string, number>();

  return Object.fromEntries(
    Object.entries(tools).map(([toolName, originalTool]) => {
      const shouldWrap =
        (!include || include.includes(toolName)) && !(exclude ?? []).includes(toolName);
      const originalExecute = originalTool?.execute;

      if (!shouldWrap || typeof originalExecute !== "function") {
        return [toolName, originalTool];
      }

      const wrapped = {
        ...originalTool,
        execute: async (input: unknown, executeOptions: unknown) => {
          const result = await originalExecute.call(
            originalTool,
            input as never,
            executeOptions as never
          );

          if (isErrorResult(result)) {
            return result;
          }

          const serialized = serialize?.(result, toolName) ?? defaultSerialize(result);
          if (serialized.text.length < minCharacters) {
            return result;
          }

          const callCount = (callCounts.get(toolName) ?? 0) + 1;
          callCounts.set(toolName, callCount);

          const resolvedFileName =
            fileName?.({ toolName, callCount, extension: serialized.extension }) ??
            `${sanitizeFileNamePart(toolName)}_${callCount}.${serialized.extension}`;
          const path = `${targetDirectory}/${resolvedFileName}`;

          try {
            await bash.writeFile(path, serialized.text);
          } catch (error) {
            // Falling back to the inline result keeps the agent working even if
            // the virtual filesystem rejects the write.
            console.warn("[just-bash-io] failed to offload tool result", { toolName, path, error });
            return result;
          }

          onOffload?.({ toolName, path, characterCount: serialized.text.length });

          const output: OffloadedToolOutput = {
            offloaded: true,
            path,
            characterCount: serialized.text.length,
            lineCount: serialized.text.split("\n").length,
            hint: `The full result was saved to ${path}. Use the bash tool to inspect and process it. Do not ask for the file to be pasted back into the conversation.`,
            ...buildPreview(serialized.text, preview ?? {}),
          };

          return output;
        },
      };

      return [toolName, wrapped];
    })
  ) as ToolSet;
}
