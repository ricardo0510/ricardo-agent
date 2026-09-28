# agent-cli

从零手写的最小 AI agent。目的不是「好用」,是让你**看清 agent 的本质**:模型 + 工具 + 一个循环。走完七步,你拥有「手写版」「框架版」「RAG 版」和一套 eval,每一层都知道为什么。

1. **CLI agent** — tool calling + ReAct 循环
2. **流式 + 联网搜索** — SSE 解析、分片拼接
3. **网页可视化面板** — 执行过程实时可见
4. **会话记忆** — 多轮对话 + 上下文窗口管理
5. **框架对比** — 用 AI SDK 7 重写,体会框架的取舍
6. **eval 评测** — 三层断言,量化改动到底有没有变好
7. **RAG** — 本地 embedding + 向量检索,挂私有知识库

## 跑起来

```bash
npm install
cp .env.example .env   # 填入你的 key
```

**手写版(零依赖):**

```bash
npm run agent                          # CLI 交互(带记忆,clear 清空)
npm run web                            # 网页面板 http://localhost:8787
npm run eval                           # 跑评测
```

**框架版(AI SDK 7):**

```bash
cd framework && npm install
npm run agent -- 悉尼和襄阳现在各几度   # 单次
```

**RAG 版(本地 embedding):**

```bash
cd rag && npm install
npm run ask                            # 交互问答
npm run ask -- 留学生每周能打工多久     # 单次
```

## 文件结构

| 路径 | 说明 |
|---|---|
| `src/llm.ts` | 手写:非流式 `chat` + 流式 `chatStream`(SSE 解析 + 分片拼接) |
| `src/tools.ts` | 5 个工具的实现(纯逻辑,各版本共用)+ 手写版注册表 |
| `src/agent.ts` | 手写:ReAct 循环 + 会话管理,吐事件流 |
| `src/eval.ts` | 评测脚本:三层断言 |
| `src/index.ts` / `src/server.ts` | CLI / Web 入口 |
| `public/index.html` | 前端面板 |
| `framework/main.ts` | AI SDK 7 版:框架重写 |
| `rag/main.ts` | RAG 版:embedding + 向量检索 + 生成 |
| `rag/docs/` | 知识库文档(放你的 .md/.txt 进去) |

## 那个循环(背下来)

```
messages = [system, user]
循环:
  回复 = 调模型(messages, tools)
  把回复塞进 messages
  如果回复里没有 tool_calls → 这就是最终答案,结束
  否则:对每个 tool_call,执行对应函数,把结果作为 tool 消息塞回 messages
```

## 第 6 项目:eval 评测

三层断言(`expectTools` / `expectToolResults` / `expectContains`)。最反直觉的一课:**强模型会自我纠错,掩盖工具 bug**,所以必须直接断言工具结果,不能只测最终答案。

## 第 7 项目:RAG

流程:文档 → 分块 → embedding(本地 bge-small-zh-v1.5,中文模型)→ 余弦相似度检索 top-k → 拼进 prompt 生成。解决 LLM 的「知识截止」和「幻觉」。

面试要点(都在 `rag/main.ts` 顶部注释里):

1. 为什么 RAG:LLM 知识有截止 + 没有私有数据 + 会幻觉
2. 流程:chunk → embed → retrieve → generate
3. embedding:把文本映射成向量,语义相近则向量相近
4. 检索:余弦相似度找 top-k
5. chunk 大小:太小丢上下文,太大检索不精确

实测:问「留学生每周能打工多久」→ 检索到打工文档 → 答「每两周 48 小时」;问「澳洲怎么考驾照」(资料里没有)→ 答「资料里没有相关信息」,不编造。

## 自己加一个工具 / 加知识库文档

- 加工具:`src/tools.ts` 写函数 + 登记(手写版)或 `tool({...})`(框架版)
- 加知识:`rag/docs/` 放 .md/.txt 文件,重跑 `npm run ask` 即可

## 改模型

默认 DeepSeek。手写/RAG 版改 `.env`;框架版把 `createDeepSeek` 换成别的 provider。
