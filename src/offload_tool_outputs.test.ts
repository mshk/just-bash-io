import { describe, expect, it, vi } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import { createBashTools, DEFAULT_WORKING_DIRECTORY } from "./bash_tools.js";
import { offloadToolOutputs, type OffloadedToolOutput } from "./offload_tool_outputs.js";

const bigRows = Array.from({ length: 200 }, (_, index) => `cow-${index},${index * 10}`).join("\n");

function fakeTool(result: unknown) {
  return tool({
    description: "test tool",
    inputSchema: z.object({}),
    execute: async () => result,
  });
}

async function run(tools: Record<string, any>, name: string) {
  return tools[name].execute({}, {} as any);
}

describe("offloadToolOutputs", () => {
  it("writes a large result to the virtual filesystem and returns only metadata", async () => {
    const { bash } = await createBashTools();
    const tools = offloadToolOutputs({ listCows: fakeTool(bigRows) }, { bash });

    const output = (await run(tools as Record<string, any>, "listCows")) as OffloadedToolOutput;

    expect(output.offloaded).toBe(true);
    expect(output.path).toBe(`${DEFAULT_WORKING_DIRECTORY}/data/listCows_1.txt`);
    expect(output.lineCount).toBe(200);
    expect(await bash.readFile(output.path)).toBe(bigRows);
    expect(JSON.stringify(output)).not.toContain("cow-199");
  });

  it("keeps small results inline", async () => {
    const { bash } = await createBashTools();
    const tools = offloadToolOutputs({ listCows: fakeTool("3 cows") }, { bash });

    expect(await run(tools as Record<string, any>, "listCows")).toBe("3 cows");
  });

  it("includes a leading preview so the model can see the data shape", async () => {
    const { bash } = await createBashTools();
    const tools = offloadToolOutputs(
      { listCows: fakeTool(bigRows) },
      { bash, preview: { lines: 2 } }
    );

    const output = (await run(tools as Record<string, any>, "listCows")) as OffloadedToolOutput;

    expect(output.preview).toBe("cow-0,0\ncow-1,10");
    expect(output.previewTruncated).toBe(true);
  });

  it("omits the preview when disabled", async () => {
    const { bash } = await createBashTools();
    const tools = offloadToolOutputs({ listCows: fakeTool(bigRows) }, { bash, preview: false });

    const output = (await run(tools as Record<string, any>, "listCows")) as OffloadedToolOutput;

    expect(output.preview).toBeUndefined();
  });

  it("stores MCP text content as .json when it parses as JSON", async () => {
    const { bash } = await createBashTools();
    const payload = JSON.stringify({ cows: Array.from({ length: 100 }, (_, i) => ({ id: i })) });
    const tools = offloadToolOutputs(
      { umotion_listCows: fakeTool({ content: [{ type: "text", text: payload }] }) },
      { bash }
    );

    const output = (await run(tools as Record<string, any>, "umotion_listCows")) as OffloadedToolOutput;

    expect(output.path.endsWith(".json")).toBe(true);
    expect(await bash.readFile(output.path)).toBe(payload);
  });

  it("serializes plain objects as pretty JSON", async () => {
    const { bash } = await createBashTools();
    const tools = offloadToolOutputs(
      { report: fakeTool({ rows: Array.from({ length: 100 }, (_, i) => ({ id: i })) }) },
      { bash }
    );

    const output = (await run(tools as Record<string, any>, "report")) as OffloadedToolOutput;

    expect(output.path.endsWith(".json")).toBe(true);
    expect(JSON.parse(await bash.readFile(output.path))).toHaveProperty("rows");
  });

  it("never offloads error results", async () => {
    const { bash } = await createBashTools();
    const errorResult = { isError: true, content: [{ type: "text", text: bigRows }] };
    const tools = offloadToolOutputs({ listCows: fakeTool(errorResult) }, { bash });

    expect(await run(tools as Record<string, any>, "listCows")).toBe(errorResult);
  });

  it("numbers files per tool so repeated calls do not overwrite each other", async () => {
    const { bash } = await createBashTools();
    const tools = offloadToolOutputs({ listCows: fakeTool(bigRows) }, { bash });

    const first = (await run(tools as Record<string, any>, "listCows")) as OffloadedToolOutput;
    const second = (await run(tools as Record<string, any>, "listCows")) as OffloadedToolOutput;

    expect(first.path).not.toBe(second.path);
  });

  it("respects include / exclude", async () => {
    const { bash } = await createBashTools();
    const tools = offloadToolOutputs(
      { listCows: fakeTool(bigRows), listFarms: fakeTool(bigRows) },
      { bash, exclude: ["listFarms"] }
    );

    expect((await run(tools as Record<string, any>, "listCows")) as OffloadedToolOutput).toHaveProperty(
      "offloaded",
      true
    );
    expect(await run(tools as Record<string, any>, "listFarms")).toBe(bigRows);
  });

  it("supports a custom file name and reports offloads", async () => {
    const { bash } = await createBashTools();
    const onOffload = vi.fn();
    const tools = offloadToolOutputs(
      { listCows: fakeTool(bigRows) },
      {
        bash,
        directory: `${DEFAULT_WORKING_DIRECTORY}/raw`,
        fileName: ({ toolName }) => `${toolName}.csv`,
        onOffload,
      }
    );

    const output = (await run(tools as Record<string, any>, "listCows")) as OffloadedToolOutput;

    expect(output.path).toBe(`${DEFAULT_WORKING_DIRECTORY}/raw/listCows.csv`);
    expect(onOffload).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "listCows", path: output.path })
    );
  });

  it("feeds the offloaded file straight into bash and the sink", async () => {
    const sink = vi.fn();
    const { tools: bashTools, bash } = await createBashTools({ sink: { sink } });
    const dataTools = offloadToolOutputs({ listCows: fakeTool(bigRows) }, { bash });

    const offloaded = (await run(dataTools as Record<string, any>, "listCows")) as OffloadedToolOutput;
    await (bashTools as Record<string, any>).bash.execute(
      { command: `awk -F, '{ total += $2 } END { print "total:", total }' ${offloaded.path} > report.md` },
      {} as any
    );
    await (bashTools as Record<string, any>).sendFileToUser.execute({ path: "report.md" }, {} as any);

    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("total: 199000") })
    );
  });
});
