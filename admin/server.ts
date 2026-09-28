// 后台管理系统:知识库管理 + 可观测性(会话记录 / token 成本统计)。
//
// 解决「每次维护都要改文件 / 改代码」的痛点:
//   - 知识库文档:界面上传 / 删除 / 重建索引 / 试问,不用手动碰 rag/docs/ 文件
//   - 可观测性:每次跑 agent 自动记录会话、token 用量、成本、错误,落到 data/sessions.jsonl
//
// 路由:
//   GET    /                  → 后台页面(public/index.html)
//   GET    /api/docs          → 列出知识库文档
//   POST   /api/docs          → 上传文档 { name, content }
//   DELETE /api/docs?name=x   → 删除文档
//   POST   /api/rebuild       → 重建索引
//   POST   /api/ask           → RAG 试问 { question }
//   POST   /api/run           → 跑 agent { question },记录会话
//   GET    /api/sessions      → 会话历史(倒序,limit 参数)
//   GET    /api/stats         → 汇总统计(token / 成本 / 错误 / 工具排行)

import { createServer } from "node:http";
import { readFile, writeFile, readdir, unlink, appendFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../src/env.js";
import { createConversation, runAgent, type RunStats } from "../src/agent.js";
import type { Usage } from "../src/llm.js";
import { buildIndex, answer, DOCS_DIR, type RagIndex } from "../rag/index.js";

process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
loadEnv();

const PORT = Number(process.env.ADMIN_PORT ?? 8789);
const HTML_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "public/index.html");
const DATA_DIR = path.resolve("data");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.jsonl");

// DeepSeek deepseek-chat 公开价(每百万 token,美元)。换成别的模型时改这两个数。
const PRICE_INPUT_PER_M = 0.27;
const PRICE_OUTPUT_PER_M = 1.1;

// ---------- 会话记录 ----------

interface SessionRecord {
  id: string;
  question: string;
  answer: string;
  toolsCalled: string[];
  usage?: Usage;
  cost: number;
  durationMs: number;
  error?: string;
  timestamp: string;
}

function calcCost(usage: Usage | undefined): number {
  if (!usage) return 0;
  return (usage.prompt_tokens / 1e6) * PRICE_INPUT_PER_M + (usage.completion_tokens / 1e6) * PRICE_OUTPUT_PER_M;
}

async function appendSession(rec: SessionRecord): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await appendFile(SESSIONS_FILE, JSON.stringify(rec) + "\n", "utf-8");
}

async function readSessions(): Promise<SessionRecord[]> {
  try {
    const text = await readFile(SESSIONS_FILE, "utf-8");
    return text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as SessionRecord);
  } catch {
    return []; // 文件不存在 = 还没有记录
  }
}

// ---------- 知识库索引(内存中,上传/删除后重建)----------

let rag: RagIndex | null = null;

async function rebuild(): Promise<{ ok: boolean; chunks?: number; error?: string }> {
  try {
    rag = await buildIndex();
    return { ok: true, chunks: rag.chunks.length };
  } catch (e) {
    rag = null;
    return { ok: false, error: (e as Error).message };
  }
}

const startup = await rebuild();
console.log(startup.ok ? `✅ 知识库索引就绪:${startup.chunks ?? 0} 个文本块` : `⚠️ 暂无文档:${startup.error}`);

// ---------- HTTP 工具 ----------

function json(res: import("node:http").ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function readJsonBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return JSON.parse(body);
}

// ---------- 服务器 ----------

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  // 后台页面
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    const html = await readFile(HTML_PATH, "utf-8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  // 列出文档
  if (req.method === "GET" && url.pathname === "/api/docs") {
    const files = (await readdir(DOCS_DIR)).filter((f) => /\.(md|txt)$/.test(f));
    const list = await Promise.all(
      files.map(async (name) => {
        const s = await stat(path.join(DOCS_DIR, name));
        return { name, size: s.size, mtime: s.mtime.toISOString() };
      })
    );
    list.sort((a, b) => a.name.localeCompare(b.name));
    json(res, 200, { docs: list, indexed: rag?.chunks.length ?? 0 });
    return;
  }

  // 上传文档
  if (req.method === "POST" && url.pathname === "/api/docs") {
    let name: string, content: string;
    try {
      const parsed = (await readJsonBody(req)) as { name: string; content: string };
      name = parsed.name;
      content = parsed.content;
    } catch {
      json(res, 400, { error: "请求体需要是 {name: string, content: string}" });
      return;
    }
    // 文件名校验:禁止路径分隔符(/ \),防路径穿越;中文名合法。只允许 .md/.txt。
    if (!/^[^/\\]+\.(md|txt)$/.test(name)) {
      json(res, 400, { error: "文件名不能含路径分隔符,且以 .md 或 .txt 结尾" });
      return;
    }
    await writeFile(path.join(DOCS_DIR, name), content, "utf-8");
    const r = await rebuild();
    json(res, 200, { ok: r.ok, name, indexed: r.chunks ?? 0, error: r.error });
    return;
  }

  // 删除文档
  if (req.method === "DELETE" && url.pathname === "/api/docs") {
    const name = url.searchParams.get("name") ?? "";
    if (!/^[^/\\]+\.(md|txt)$/.test(name)) {
      json(res, 400, { error: "非法文件名" });
      return;
    }
    await unlink(path.join(DOCS_DIR, name)).catch(() => {});
    const r = await rebuild();
    json(res, 200, { ok: r.ok, name, indexed: r.chunks ?? 0, error: r.error });
    return;
  }

  // 重建索引(手动)
  if (req.method === "POST" && url.pathname === "/api/rebuild") {
    const r = await rebuild();
    json(res, 200, r);
    return;
  }

  // RAG 试问
  if (req.method === "POST" && url.pathname === "/api/ask") {
    let question: string;
    try {
      question = ((await readJsonBody(req)) as { question: string }).question;
    } catch {
      json(res, 400, { error: "请求体需要是 {question: string}" });
      return;
    }
    if (!rag) {
      json(res, 200, { error: "知识库为空,请先上传文档。" });
      return;
    }
    const { answer: text, chunks } = await answer(rag, question);
    json(res, 200, {
      answer: text,
      chunks: chunks.map((c) => ({ source: c.source, score: c.score, text: c.text })),
    });
    return;
  }

  // 跑 agent + 记录会话
  if (req.method === "POST" && url.pathname === "/api/run") {
    let question: string;
    try {
      question = ((await readJsonBody(req)) as { question: string }).question;
    } catch {
      json(res, 400, { error: "请求体需要是 {question: string}" });
      return;
    }

    const conv = createConversation();
    let fullAnswer = "";
    let stats: RunStats | undefined;
    const t0 = Date.now();
    const record: SessionRecord = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      question,
      answer: "",
      toolsCalled: [],
      cost: 0,
      durationMs: 0,
      timestamp: new Date().toISOString(),
    };

    try {
      await runAgent(conv, question, {
        onToken: (c) => (fullAnswer += c),
        onToolCall: () => {},
        onToolResult: () => {},
        onDone: (s) => (stats = s),
      });
      // 最终答案 = 最后一条 assistant 消息(而非中间轮次的过渡文本)
      const last = [...conv.messages].reverse().find((m) => m.role === "assistant");
      record.answer = last?.content ?? fullAnswer;
      record.toolsCalled = stats?.toolsCalled ?? [];
      record.usage = stats?.usage;
      record.cost = calcCost(stats?.usage);
    } catch (e) {
      record.answer = fullAnswer;
      record.error = (e as Error).message;
    }
    record.durationMs = Date.now() - t0;
    await appendSession(record);

    json(res, 200, {
      id: record.id,
      answer: record.answer,
      toolsCalled: record.toolsCalled,
      usage: record.usage,
      cost: record.cost,
      durationMs: record.durationMs,
      error: record.error,
    });
    return;
  }

  // 会话历史(倒序)
  if (req.method === "GET" && url.pathname === "/api/sessions") {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
    const sessions = await readSessions();
    json(res, 200, { sessions: sessions.slice(-limit).reverse() });
    return;
  }

  // 汇总统计
  if (req.method === "GET" && url.pathname === "/api/stats") {
    const sessions = await readSessions();
    const toolCount = new Map<string, number>();
    let totalTokens = 0;
    let totalCost = 0;
    let errors = 0;
    for (const s of sessions) {
      totalTokens += s.usage?.total_tokens ?? 0;
      totalCost += s.cost;
      if (s.error) errors++;
      for (const t of s.toolsCalled) toolCount.set(t, (toolCount.get(t) ?? 0) + 1);
    }
    const topTools = [...toolCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    json(res, 200, {
      total: sessions.length,
      totalTokens,
      totalCost: Number(totalCost.toFixed(6)),
      errors,
      topTools: topTools.map(([name, count]) => ({ name, count })),
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("404 Not Found");
});

server.listen(PORT, () => {
  console.log(`🛠️  后台管理系统已启动:http://localhost:${PORT}`);
});
