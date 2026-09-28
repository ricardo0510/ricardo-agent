// RAG CLI 入口:命令行问答,单次模式会先展示检索到的资料块。
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../src/env.js";
import { buildIndex, answer } from "./index.js";

process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
loadEnv();

async function main() {
  console.log("加载知识库 + 建索引...");
  const rag = await buildIndex();
  console.log(`✅ ${rag.chunks.length} 个文本块,就绪。\n`);

  // 单次模式:`npm run ask -- 留学生每周能打工多久`
  const cliQuestion = process.argv.slice(2).join(" ").trim();
  if (cliQuestion) {
    const { answer: text, chunks } = await answer(rag, cliQuestion);
    console.log("检索到的资料:");
    chunks.forEach((c, i) => console.log(`  [${i + 1}] ${c.source} (相关度 ${c.score!.toFixed(3)})`));
    console.log(`\n🤖 ${text}`);
    process.exit(0);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const loop = () =>
    rl.question("你 > ", async (q) => {
      const question = q.trim();
      if (!question) {
        loop();
        return;
      }
      if (question.toLowerCase() === "exit") {
        rl.close();
        return;
      }
      try {
        const { answer: text } = await answer(rag, question);
        console.log(`\n🤖 ${text}\n`);
      } catch (e) {
        console.error("出错了:", (e as Error).message);
      }
      loop();
    });
  loop();
}

main();
