// extract-test.js — 回归测试：从真实事件形状中提取最终回答（此前因无 turn/start 事件导致提取为空）。
"use strict";

import { extractTextBlocks, eventToLogLine } from "../lib/agent.js";

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
}

// 真实事件序列：没有 turn/start，assistant/message 包含 reasoning + text（或 tool-call）
function makeEvents(blocks) {
  return [
    { seq: 0, type: "step/start", data: {} },
    { seq: 1, type: "user/message", data: {} },
    { seq: 2, type: "assistant/message", data: { message: { content: blocks } } },
    { seq: 3, type: "step/end", data: {} },
    { seq: 4, type: "turn/end", data: { reason: { kind: "completed" } } },
  ];
}

// 1) reasoning + text（标准成功路径）
{
  const blocks = [
    { type: "reasoning", text: "The user asks in Chinese..." },
    { type: "text", text: "我是 DSH 助手，可以帮你执行命令和读写文件。" },
  ];
  const events = makeEvents(blocks);
  let text = "";
  for (const ev of events) {
    if (ev.seq < 0) continue;
    if (ev.type === "assistant/message") {
      const joined = extractTextBlocks(ev.data.message);
      if (joined !== "") text = joined;
    }
  }
  check("reasoning+text -> 提取文本块", text.includes("我是 DSH 助手"), `got: ${text}`);
  check("reasoning 不进入结果", !text.includes("The user asks"), text);
}

// 2) 多步：第一步 reasoning+tool-call 无文本，第二步 reasoning+text
{
  const step1 = [{ type: "reasoning", text: "I need to list the dir" }, { type: "tool-call", name: "list_dir" }];
  const step2 = [{ type: "reasoning", text: "Now I summarize" }, { type: "text", text: "目录如下：..." }];
  let text = "";
  for (const ev of [
    { seq: 0, type: "assistant/message", data: { message: { content: step1 } } },
    { seq: 1, type: "tool/start", data: { name: "list_dir" } },
    { seq: 2, type: "assistant/message", data: { message: { content: step2 } } },
  ]) {
    if (ev.type === "assistant/message") {
      const joined = extractTextBlocks(ev.data.message);
      if (joined !== "") text = joined;
    }
  }
  check("工具步无文本时取最终文本", text === "目录如下：...", `got: ${text}`);
}

// 3) 无文本块（全 reasoning）→ 空
{
  const blocks = [{ type: "reasoning", text: "just thinking" }];
  const text = extractTextBlocks({ content: blocks });
  check("全 reasoning -> 空", text === "", `got: ${text}`);
}

// 4) eventToLogLine：reasoning 块不应产生 assistant 日志行
{
  const line = eventToLogLine({ type: "assistant/message", data: { message: { content: [{ type: "reasoning", text: "x" }] } } });
  check("reasoning 块不产生日志", line === null, JSON.stringify(line));
  const line2 = eventToLogLine({ type: "assistant/message", data: { message: { content: [{ type: "text", text: "hi" }] } } });
  check("text 块产生日志", line2 && line2.text === "hi", JSON.stringify(line2));
}

// 5) turn/end error -> 错误日志
{
  const line = eventToLogLine({ type: "turn/end", data: { reason: { kind: "error", error: { code: "X", message: "boom" } } } });
  check("turn/end error 产生错误日志", line && line.level === "error" && line.text.includes("boom"), JSON.stringify(line));
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
