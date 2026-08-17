// agent.js — 把微信消息交给本地 DSH Agent（进程内运行，使用当前 profile 的模型配置）。
// 通过 ctx 注入的 agents / sessions / agentDefaultModel 服务驱动，不修改 DSH 核心代码。
"use strict";

import { randomUUID } from "node:crypto";

/** 从会话事件流里挑出对用户有意义的日志行。 */
export function eventToLogLine(event) {
  const d = event?.data;
  switch (event?.type) {
    case "turn/start":
      return { level: "info", text: "开始处理…" };
    case "assistant/message": {
      const text = (d?.message?.content ?? [])
        .filter((b) => b?.type === "text" && b?.text)
        .map((b) => b.text)
        .join("")
        .trim();
      return text ? { level: "assistant", text } : null;
    }
    case "tool/start":
      return { level: "tool", text: `工具调用: ${d?.name ?? d?.tool ?? "?"}` };
    case "tool/end": {
      const name = d?.name ?? d?.tool ?? "?";
      const err = d?.error ?? d?.reason;
      return err
        ? { level: "error", text: `工具 ${name} 出错: ${typeof err === "string" ? err : JSON.stringify(err).slice(0, 300)}` }
        : { level: "tool", text: `工具完成: ${name}` };
    }
    case "turn/end": {
      const reason = d?.reason;
      if (reason?.kind === "error") {
        return { level: "error", text: `执行出错: ${reason.error?.code ?? ""} ${reason.error?.message ?? ""}`.trim() };
      }
      return null;
    }
    case "message/created":
    case "message/updated":
      return null;
    default:
      return null;
  }
}

/** 从 assistant/message 事件中提取纯文本（跳过 reasoning/thinking 块）。 */
export function extractTextBlocks(message) {
  return (message?.content ?? [])
    .filter((b) => b?.type === "text" && typeof b?.text === "string" && b.text.trim() !== "")
    .map((b) => b.text)
    .join("");
}

/**
 * 组装 agent 的 setup：加入 standard 预设（挂载工具、提示词片段、技能目录）。
 * 必须在 agents.create 的 setup(agentCtx) 中调用，否则 agent 没有任何工具。
 */
function makeSetup(agentPresets) {
  if (!agentPresets?.mount) return undefined;
  return async (agentCtx) => {
    await agentPresets.mount(agentCtx, "standard");
  };
}

/**
 * 在指定工作目录运行一个 DSH Agent 任务，返回最终文本与结果。
 * @param {object} svc - { agents, agentDefaultModel, sessions, agentPresets }（从 ctx 获取）
 * @param {object} opts - { prompt, workspace, onLog(line), signal }
 * @returns {Promise<{text:string, reason?:any, error?:string}>}
 */
export async function runAgentTask(svc, opts) {
  const { agents, agentDefaultModel, sessions } = svc;
  const selection = agentDefaultModel?.currentSelection?.() ?? null;
  const sessionId = `session-${randomUUID()}`;

  let agent = null;
  const created = await agents.create({
    sessionId,
    meta: { cwd: opts.workspace, agentPreset: "standard" },
    ...(selection
      ? { agentOptions: { provider: selection.provider, model: selection.model } }
      : {}),
    setup: makeSetup(svc.agentPresets),
  });
  agent = created.agent ?? created;
  await agent.whenIdle?.();

  const input = {
    content: [{ type: "text", text: opts.prompt }],
    source: { kind: "user" },
  };
  agent.followup(input);

  const firstSeq = agent.session?.seq ?? 0;
  let seen = firstSeq;
  let done = false;
  let pollTimer = null;

  // 轮询事件流，把新日志推给调用方（微信侧实时转发）
  const pollEvents = () => {
    if (done || !agent?.session?.events) return;
    const events = agent.session.events;
    for (; seen < events.length; seen++) {
      const line = eventToLogLine(events[seen]);
      if (line) opts.onLog?.(line, events[seen]);
    }
  };
  pollTimer = setInterval(pollEvents, 800);

  const abortSignal = opts.signal;
  const abortHandler = () => {
    try {
      agent?.cancel?.({ kind: "interrupted" }, { skipHooks: true });
    } catch {
      /* 尽力而为 */
    }
  };
  abortSignal?.addEventListener?.("abort", abortHandler, { once: true });

  try {
    await agent.whenIdle?.();
    await sessions?.flush?.(agent.session);
    pollEvents(); // 先补抓尾部事件，再置 done
    done = true;
    const events = agent.session?.events ?? [];
    let text = "";
    let reason;
    // 注意：此 agent 循环版本不发射 turn/start，不能以它作为“已开始”的门槛；
    // 直接取 followup 之后所有 assistant/message 的文本块，最后一个非空文本即最终回答。
    for (const ev of events) {
      if (ev.seq < firstSeq) continue;
      if (ev.type === "assistant/message") {
        const joined = extractTextBlocks(ev.data?.message);
        if (joined !== "") text = joined;
      }
      if (ev.type === "turn/end") reason = ev.data?.reason;
    }
    if (reason?.kind === "error") {
      return { text, reason, error: `${reason.error?.code ?? "error"}: ${reason.error?.message ?? ""}`.trim() };
    }
    return { text, reason };
  } finally {
    clearInterval(pollTimer);
    abortSignal?.removeEventListener?.("abort", abortHandler);
  }
}
