// RAG 核心:建索引 + 问答。CLI(main.ts)和 Web(server.ts)共用。
//
// 流程:文档 → 分块 → embedding(本地 all-MiniLM-L6-v2)→ 余弦相似度检索 top-k → 拼进 prompt 生成。
// 面试要点(背下来):
//   1. 为什么 RAG:LLM 知识有截止日期 + 没有你的私有数据 + 会幻觉
//   2. 流程:chunk → embed → retrieve(top-k)→ 拼进 prompt → 生成
//   3. embedding 是什么:把文本映射成向量,语义相近的文本向量也相近
//   4. 检索靠什么:余弦相似度,找最相近的 top-k 块
//   5. chunk 大小:太小丢上下文,太大检索不精确(常见 200-500 字)

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "@xenova/transformers";
import { chat } from "../src/llm.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DOCS_DIR = path.resolve(HERE, "docs");
export const TOP_K = 3;

export interface Chunk {
  text: string;
  source: string;
  vec?: number[];
  score?: number;
}

export interface RagIndex {
  chunks: Chunk[];
  extractor: any;
}

export async function buildIndex(): Promise<RagIndex> {
  const files = (await readdir(DOCS_DIR)).filter((f) => /\.(md|txt)$/.test(f));
  if (files.length === 0) {
    console.error("❌ rag/docs/ 下没有文档,放几个 .md 文件进去。");
    process.exit(1);
  }

  const chunks: Chunk[] = [];
  for (const f of files) {
    const content = await readFile(path.join(DOCS_DIR, f), "utf-8");
    for (const para of content.split(/\n\s*\n/)) {
      const text = para.trim();
      if (text.length > 20) chunks.push({ text, source: f });
    }
  }

  const extractor = await pipeline("feature-extraction", "Xenova/bge-small-zh-v1.5");
  const vecs: number[][] = [];
  for (const c of chunks) {
    const out = await extractor(c.text, { pooling: "mean", normalize: true });
    vecs.push(Array.from(out.data));
  }
  chunks.forEach((c, i) => (c.vec = vecs[i]));
  return { chunks, extractor };
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export interface Answer {
  answer: string;
  chunks: Chunk[];
}

export async function answer(rag: RagIndex, question: string): Promise<Answer> {
  const out = await rag.extractor(question, { pooling: "mean", normalize: true });
  const qvec = Array.from(out.data);

  const top = rag.chunks
    .map((c) => ({ ...c, score: cosine(qvec, c.vec!) }))
    .sort((a, b) => b.score! - a.score!)
    .slice(0, TOP_K);

  const context = top.map((c, i) => `[资料${i + 1}] (来源:${c.source})\n${c.text}`).join("\n\n");

  const messages = [
    {
      role: "system" as const,
      content:
        `你是知识库助手。严格根据下面提供的资料回答用户问题。如果资料里没有答案,就回答「资料里没有相关信息」,不要编造。\n\n资料:\n${context}`,
    },
    { role: "user" as const, content: question },
  ];

  const reply = await chat(messages);
  return { answer: reply.content ?? "(空回复)", chunks: top };
}
