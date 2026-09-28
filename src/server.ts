// 零依赖 HTTP 服务器:一个页面 + 一个 SSE 接口。
//   GET  /          → 前端页面(public/index.html)
//   POST /api/run   → 启动一次 agent,用 SSE 把执行过程实时推给浏览器
//
// 会话记忆:前端每次请求带一个 sessionId,后端为每个 sessionId
// 维护一个独立的 Conversation。同一个标签页连续提问,历史自动累积;
// 点「新对话」换一个 sessionId,就从零开始。

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./env.js";
import { createConversation, runAgent, type Conversation } from "./agent.js";

loadEnv();

if (!process.env.OPENAI_API_KEY) {
  console.error("❌ 缺少 OPENAI_API_KEY。\n请复制 .env.example 为 .env,填入你的 key,然后重新运行。");
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 8787);
const HTML_PATH = fileURLToPath(new URL("../public/index.html", import.meta.url));

// sessionId → 会话。生产环境要换成 Redis 之类(重启不丢、多实例共享),
// 这里内存 Map 对本地演示够用。
const sessions = new Map<string, Conversation>();

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  // 前端页面
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    const html = await readFile(HTML_PATH, "utf-8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  // agent 执行(SSE 流)
  if (req.method === "POST" && url.pathname === "/api/run") {
    let body = "";
    for await (const chunk of req) body += chunk;

    let question: string;
    let sessionId: string;
    try {
      const parsed = JSON.parse(body);
      question = parsed.question as string;
      sessionId = parsed.sessionId as string;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "请求体需要是 {question: string, sessionId?: string}" }));
      return;
    }

    // 按 sessionId 找到(或新建)会话
    if (!sessionId) sessionId = "default";
    let conv = sessions.get(sessionId);
    if (!conv) {
      conv = createConversation();
      sessions.set(sessionId, conv);
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const send = (event: string, data: unknown) => {
      if (res.writableEnded || res.destroyed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      await runAgent(conv, question, {
        onToken: (chunk) => send("token", { chunk }),
        onToolCall: (name, args) => send("tool_call", { name, args }),
        onToolResult: (result) => send("tool_result", { result }),
        onDone: () => {
          send("done", {});
          res.end();
        },
      });
    } catch (e) {
      send("error", { msg: (e as Error).message });
      res.end();
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("404 Not Found");
});

server.listen(PORT, () => {
  console.log(`🌐 Agent 面板已启动:http://localhost:${PORT}`);
});
