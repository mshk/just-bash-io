import { describe, expect, it, vi } from "vitest";
import {
  createBashTools,
  DEFAULT_SINK_TOOL_NAME,
  DEFAULT_WORKING_DIRECTORY,
  type SinkPayload,
} from "./bash_tools.js";

type BashResult = { stdout: string; stderr: string; exitCode: number };

async function runBash(tools: Record<string, any>, command: string): Promise<BashResult> {
  return (await tools.bash.execute({ command }, {} as any)) as BashResult;
}

async function send(tools: Record<string, any>, path: string) {
  return tools[DEFAULT_SINK_TOOL_NAME].execute({ path }, {} as any);
}

describe("createBashTools", () => {
  it("exposes only the bash tools when no sink is configured", async () => {
    const { tools } = await createBashTools();

    expect(Object.keys(tools).sort()).toEqual(["bash", "readFile", "writeFile"]);
  });

  it("exposes the sink tool when a sink is configured", async () => {
    const { tools } = await createBashTools({ sink: { sink: vi.fn() } });

    expect(Object.keys(tools).sort()).toEqual([
      "bash",
      DEFAULT_SINK_TOOL_NAME,
      "readFile",
      "writeFile",
    ].sort());
  });

  it("honours a custom sink tool name", async () => {
    const { tools } = await createBashTools({
      sink: { sink: vi.fn(), toolName: "deliverReport" },
    });

    expect(tools.deliverReport).toBeDefined();
    expect(tools[DEFAULT_SINK_TOOL_NAME]).toBeUndefined();
  });

  it("delivers a file written by bash without returning its content to the model", async () => {
    const received: SinkPayload[] = [];
    const { tools } = await createBashTools({
      sink: { sink: (payload) => void received.push(payload) },
    });

    await runBash(tools as Record<string, any>, "printf '| cow | milk |\\n' > report.md");
    const output = await send(tools as Record<string, any>, "report.md");

    expect(received).toHaveLength(1);
    expect(received[0]!.content).toContain("| cow | milk |");
    expect(received[0]!.path).toBe(`${DEFAULT_WORKING_DIRECTORY}/report.md`);
    expect(output).toEqual({
      sent: true,
      path: `${DEFAULT_WORKING_DIRECTORY}/report.md`,
      characterCount: received[0]!.characterCount,
    });
    expect(JSON.stringify(output)).not.toContain("milk");
  });

  it("accepts absolute paths as-is", async () => {
    const sink = vi.fn();
    const { tools } = await createBashTools({ sink: { sink } });

    await tools.writeFile!.execute!({ path: "a.txt", content: "hello" }, {} as any);
    await send(tools as Record<string, any>, `${DEFAULT_WORKING_DIRECTORY}/a.txt`);

    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ path: `${DEFAULT_WORKING_DIRECTORY}/a.txt`, content: "hello" })
    );
  });

  it("calls onBeforeSend before the sink", async () => {
    const calls: string[] = [];
    const { tools } = await createBashTools({
      sink: {
        sink: () => void calls.push("sink"),
        onBeforeSend: () => void calls.push("before"),
      },
    });

    await tools.writeFile!.execute!({ path: "a.txt", content: "hello" }, {} as any);
    await send(tools as Record<string, any>, "a.txt");

    expect(calls).toEqual(["before", "sink"]);
  });

  it("rejects a missing file", async () => {
    const sink = vi.fn();
    const { tools } = await createBashTools({ sink: { sink } });

    await expect(send(tools as Record<string, any>, "missing.txt")).rejects.toThrow(/Could not read/);
    expect(sink).not.toHaveBeenCalled();
  });

  it("rejects an empty file", async () => {
    const sink = vi.fn();
    const { tools } = await createBashTools({ sink: { sink } });

    await tools.writeFile!.execute!({ path: "empty.txt", content: "   \n" }, {} as any);

    await expect(send(tools as Record<string, any>, "empty.txt")).rejects.toThrow(/is empty/);
    expect(sink).not.toHaveBeenCalled();
  });

  it("rejects oversized content instead of truncating it", async () => {
    const sink = vi.fn();
    const { tools } = await createBashTools({
      sink: { sink, maxOutputLength: 10 },
    });

    await tools.writeFile!.execute!({ path: "long.txt", content: "x".repeat(11) }, {} as any);

    await expect(send(tools as Record<string, any>, "long.txt")).rejects.toThrow(/too long/);
    expect(sink).not.toHaveBeenCalled();
  });

  it("reports command lifecycle events", async () => {
    const onBeforeCommand = vi.fn();
    const onAfterCommand = vi.fn();
    const { tools } = await createBashTools({ onBeforeCommand, onAfterCommand });

    await runBash(tools as Record<string, any>, "echo hi");

    expect(onBeforeCommand).toHaveBeenCalledWith({ command: "echo hi" });
    expect(onAfterCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command: "echo hi", exitCode: 0 })
    );
  });

  it("uses the configured working directory", async () => {
    const { tools } = await createBashTools({ workingDirectory: "/data" });

    const result = await runBash(tools as Record<string, any>, "pwd");

    expect(result.stdout.trim()).toBe("/data");
  });

  it("keeps network access disabled by default", async () => {
    const { tools } = await createBashTools();

    const result = await runBash(tools as Record<string, any>, "curl https://example.com");

    expect(result.exitCode).not.toBe(0);
  });

  it("isolates the virtual filesystem between tool sets", async () => {
    const first = await createBashTools();
    await first.tools.writeFile!.execute!({ path: "secret.txt", content: "x" }, {} as any);

    const second = await createBashTools();
    const result = await runBash(second.tools as Record<string, any>, "cat secret.txt");

    expect(result.exitCode).not.toBe(0);
  });

  it("exposes the shared Bash instance", async () => {
    const { tools, bash } = await createBashTools();

    await runBash(tools as Record<string, any>, "echo shared > shared.txt");

    expect(await bash.readFile(`${DEFAULT_WORKING_DIRECTORY}/shared.txt`)).toContain("shared");
  });
});
