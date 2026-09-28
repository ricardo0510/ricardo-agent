// RAG Web 服务器:一个页面 + 一个问答接口。
//   GET  /          → 前端页面(public/index.html)
//   POST /api/ask   → 返回 { chunks: [{source, score, text}], answer }
//
// 重点:把「检索」过程返回给前端可视化——检索到哪些块、来自哪个文件、
// 相关度多少分。这是 RAG 最有说服力的展示。

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../src/env.js";
import { buildIndex, answer } from "./index.js";

process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
loadEnv();

const PORT = Number(process.env.PORT ?? 8788);
const HTML_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "public/index.html");

console.log("加载知识库 + 建索引...");
const rag = await buildIndex();
console.log(`✅ ${rag.chunks.length} 个文本块,索引就绪`);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    const html = await readFile(HTML_PATH, "utf-8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/ask") {
    let body = "";
    for await (const chunk of req) body += chunk;

    let question: string;
    try {
      question = JSON.parse(body).question as string;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "请求体需要是 {question: string}" }));
      return;
    }

    const { answer: text, chunks } = await answer(rag, question);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        chunks: chunks.map((c) => ({ source: c.source, score: c.score, text: c.text })),
        answer: text,
      })
    );
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("404 Not Found");
});

server.listen(PORT, () => {
  console.log(`🌐 RAG 面板已启动:http://localhost:${PORT}`);
});
