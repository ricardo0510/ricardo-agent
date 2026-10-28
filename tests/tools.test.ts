// 工具层的回归测试：路径越界 + 异步工具异常。
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readTextFile, runTool } from "../src/tools.js";

describe("read_file 路径边界", () => {
  it("拒绝 ../ 越界", async () => {
    const r = await readTextFile("../package.json");
    assert.match(r, /拒绝/);
  });

  it("允许项目内文件", async () => {
    const r = await readTextFile("README.md");
    assert.ok(r.startsWith("# agent-cli"));
  });
});

describe("runTool 异步异常", () => {
  it("工具 Promise reject 时返回错误字符串，而不是让整轮 agent 崩溃", async () => {
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("network boom");
    }) as typeof fetch;
    try {
      const result = await runTool({
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"悉尼"}' },
      });
      assert.match(result, /工具执行出错/);
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  it("上游返回 HTML 时给出可读错误，而不是把 HTML 当 JSON 解析", async () => {
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("<html>blocked</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as typeof fetch;
    try {
      const result = await runTool({
        id: "call_2",
        type: "function",
        function: { name: "search_web", arguments: '{"query":"DeepSeek"}' },
      });
      assert.match(result, /不是 JSON/);
    } finally {
      globalThis.fetch = oldFetch;
    }
  });
});
