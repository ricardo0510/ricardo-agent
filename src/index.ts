// CLI 入口:把 agent 的执行过程打印到终端,带多轮会话记忆。

import { createInterface } from "node:readline";
import { loadEnv } from "./env.js";
import { createConversation, runAgent } from "./agent.js";

loadEnv();

if (!process.env.OPENAI_API_KEY) {
  console.error("❌ 缺少 OPENAI_API_KEY。\n请复制 .env.example 为 .env,填入你的 key,然后重新运行。");
  process.exit(1);
}

function cliEvents() {
  return {
    onToken: (chunk: string) => process.stdout.write(chunk),
    onToolCall: (name: string, args: string) => console.log(`\n  🔧 调用 ${name}(${args})`),
    onGuard: (g: { allowed: boolean; reason: string }) =>
      console.log(`  🛡️ 安全门:${g.allowed ? "✅ 放行" : "⛔ 拦截"} ${g.reason}`),
    onToolResult: (result: string) => console.log(`  📄 结果:${result}`),
    onDone: () => process.stdout.write("\n"),
  };
}

const input = process.argv.slice(2).join(" ").trim();

if (input) {
  // 单次模式
  const conv = createConversation();
  try {
    await runAgent(conv, input, cliEvents());
  } catch (e) {
    console.error("出错了:", (e as Error).message);
    process.exit(1);
  }
} else {
  // 交互模式:一个 conversation 贯穿全程,历史自动累积
  let conv = createConversation();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log("Agent 已就绪(带会话记忆)。输入问题,或 clear 清空历史 / exit 退出。\n");
  const ask = () =>
    rl.question("你 > ", async (q) => {
      const trimmed = q.trim();
      if (trimmed.toLowerCase() === "exit") {
        rl.close();
        return;
      }
      if (trimmed.toLowerCase() === "clear") {
        conv = createConversation();
        console.log("已清空对话历史。\n");
        ask();
        return;
      }
      if (!trimmed) {
        ask();
        return;
      }
      try {
        await runAgent(conv, trimmed, cliEvents());
        console.log();
      } catch (e) {
        console.error("出错了:", (e as Error).message);
      }
      ask();
    });
  ask();
}
