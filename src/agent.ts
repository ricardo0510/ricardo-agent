// 核心 agent 循环 + 会话管理。
//
// 会话记忆的全部秘密就一句话:messages 数组就是记忆。
// 之前每轮都 new 一个 [system, user],模型当然「失忆」。
// 现在把 messages 存进 Conversation,跨轮次复用、只追加不重置,
// 模型就「记得」之前说过的话。
//
// 配套引入上下文窗口管理:历史无限累积会撑爆模型的 token 限制,
// 所以每轮结束后按「轮次」裁剪,保留 system + 最近 N 轮。

import { chatStream, type Message } from "./llm.js";
import { TOOLS, runTool } from "./tools.js";
import { guardToolCall, type GuardResult } from "./guard.js";

export const SYSTEM_PROMPT =
  "你是一个能使用工具的智能助手。当用户的问题需要查天气、算数、读文件、看时间或联网搜索时,调用对应的工具;拿到工具结果后,组织成自然语言回答。不需要工具就直接回答。回答用简体中文。";

const MAX_STEPS = 8; // 最多循环几轮,防止死循环
const MAX_ROUNDS = 6; // 最多保留最近几轮对话

export interface Conversation {
  messages: Message[];
}

export function createConversation(systemPrompt = SYSTEM_PROMPT): Conversation {
  return { messages: [{ role: "system", content: systemPrompt }] };
}

// 上下文窗口管理(最朴素的策略):
// 历史太长就丢掉更早的对话,保留 system + 最近 maxRounds 轮完整问答。
// 更精细的做法是按 token 数裁剪(tiktoken 计数),但轮次裁剪对演示已经够用。
function trimConversation(conv: Conversation, maxRounds = MAX_ROUNDS): void {
  const msgs = conv.messages;
  const userIdx: number[] = [];
  for (let i = 0; i < msgs.length; i++) if (msgs[i].role === "user") userIdx.push(i);
  if (userIdx.length <= maxRounds) return;
  const keepFrom = userIdx[userIdx.length - maxRounds];
  conv.messages = [msgs[0], ...msgs.slice(keepFrom)]; // system + 最近 N 轮
}

export interface AgentEvents {
  onToken: (chunk: string) => void;
  onToolCall: (name: string, args: string) => void;
  onToolResult: (result: string) => void;
  onGuard?: (guard: GuardResult) => void; // 安全门决策回调(可选)
  onDone: () => void;
}

export async function runAgent(conv: Conversation, userInput: string, events: AgentEvents): Promise<void> {
  const messages = conv.messages;
  messages.push({ role: "user", content: userInput }); // 追加,不清空 = 记住历史

  for (let step = 0; step < MAX_STEPS; step++) {
    const { content, toolCalls } = await chatStream(messages, TOOLS, events.onToken);

    messages.push({
      role: "assistant",
      content: content || null,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    });

    if (toolCalls.length === 0) {
      trimConversation(conv);
      events.onDone();
      return;
    }

    for (const call of toolCalls) {
      events.onToolCall(call.function.name, call.function.arguments);
      // 安全门:有副作用的工具(如 run_shell)在执行前先过 Kev 判断。
      // 普通工具 guardToolCall 直接放行,零开销。
      const guard = await guardToolCall(call.function.name, call.function.arguments);
      let result: string;
      if (!guard.allowed) {
        result = `⛔ 安全门拦截:${guard.reason}`;
      } else {
        result = await runTool(call);
      }
      if (guard.guarded) events.onGuard?.(guard);
      events.onToolResult(result);
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }

  trimConversation(conv);
  events.onDone();
}
