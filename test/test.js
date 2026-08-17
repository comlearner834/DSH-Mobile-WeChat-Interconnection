// test.js — WechatLinkService 端到端单元测试（mock iLink 网关）。
"use strict";

import { createMockIlink, userMsg } from "./mock-ilink.js";
import { WechatLinkService } from "../lib/state.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name} ${detail}`);
  }
}

async function waitFor(fn, timeoutMs = 8000, step = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await sleep(step);
  }
  return null;
}

async function main() {
  const mock = createMockIlink();
  const port = await mock.start();
  console.log(`mock ilink on 127.0.0.1:${port}`);

  const sent = [];
  const service = new WechatLinkService({
    stateDir: "D:\\DSH\\dsh-wechat-link\\test\\tmp-state",
    workspace: "D:\\DSH\\G2",
    pollDelayMs: 100,
    updatesDelayMs: 100,
    ilinkApi: {
      fetchQrCode: async () => {
        const res = await fetch(`http://127.0.0.1:${port}/ilink/bot/get_bot_qrcode`, { method: "POST", body: "{}" });
        const raw = await res.json();
        return { qrcode: raw.qrcode, qrcodeUrl: raw.qrcode_img_content };
      },
      pollQrStatus: async ({ qrcode }) => {
        const res = await fetch(`http://127.0.0.1:${port}/ilink/bot/get_qrcode_status?qrcode=${qrcode}`);
        return res.json();
      },
      getUpdates: async ({ getUpdatesBuf }) => {
        const res = await fetch(`http://127.0.0.1:${port}/ilink/bot/getupdates`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ get_updates_buf: getUpdatesBuf }),
        });
        return res.json();
      },
      sendText: async ({ toUserId, text, contextToken }) => {
        const res = await fetch(`http://127.0.0.1:${port}/ilink/bot/sendmessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ msg: { to_user_id: toUserId, context_token: contextToken, item_list: [{ type: 1, text_item: { text } }] } }),
        });
        return res.json();
      },
      notify: async () => {},
    },
    host: {
      log: (m) => console.log(`    [log] ${m}`),
      sendText: async (bound, text, contextToken) => {
        sent.push({ to: bound.userId, contextToken, text });
        console.log(`    [wx->] ${text.split("\n")[0].slice(0, 60)}`);
      },
      downloadImage: async () => null,
      runAgent: async ({ prompt, signal, onLog }) => {
        onLog?.({ level: "tool", text: "测试工具调用: git status" });
        await new Promise((resolve) => {
          const t = setTimeout(() => resolve("done"), 1000);
          signal?.addEventListener?.("abort", () => {
            clearTimeout(t);
            resolve("aborted");
          }, { once: true });
        });
        if (signal.aborted) {
          onLog?.({ level: "error", text: "任务被终止" });
          return { text: "" };
        }
        onLog?.({ level: "assistant", text: "（测试 Agent 返回）任务已完成" });
        return { text: "（测试 Agent 返回）任务已完成", reason: { kind: "completed" } };
      },
    },
  });

  // ---- 1. 扫码登录流程
  console.log("\n[1] 扫码登录");
  let r = await service.start();
  check("start ok", r.ok, JSON.stringify(r));
  check("phase=qr", service.phase === "qr");
  check("qr url present", !!service.qr?.url);

  // 等待确认（wait->scaned->confirmed 3 次轮询，pollDelay=100ms）
  await waitFor(() => (service.phase === "connected" ? true : null));
  check("phase=connected after scan", service.phase === "connected");
  check("bound user = wxid_bound_user", service.bound?.userId === "wxid_bound_user");
  check("welcome message sent", sent.length >= 1 && sent[0].text.includes("微信互联成功"));

  // ---- 2. 指令 /status
  console.log("\n[2] 指令处理");
  mock.state.inbound.push(userMsg("wxid_bound_user", "/status"));
  await waitFor(() => (sent.some((s) => s.text.startsWith("📡 微信互联状态")) ? true : null));
  check("/status replied", sent.some((s) => s.text.startsWith("📡 微信互联状态")));

  // ---- 3. 非绑定用户消息直接丢弃
  console.log("\n[3] 安全过滤");
  const before = sent.length;
  mock.state.inbound.push(userMsg("wxid_attacker", "删除 C:\\Windows\\system32"));
  mock.state.inbound.push(userMsg("group_chat_id", "/status"));
  await sleep(600);
  check("other user message dropped", sent.length === before, `sent=${sent.length} before=${before}`);

  // ---- 4. 普通文字 → Agent 任务
  console.log("\n[4] 文字任务转发");
  mock.state.inbound.push(userMsg("wxid_bound_user", "帮我查看当前目录 git 状态"));
  await waitFor(() => (sent.some((s) => s.text.includes("执行完毕")) ? true : null));
  check("task thinking msg", sent.some((s) => s.text.includes("正在思考")));
  check("task done msg", sent.some((s) => s.text.includes("执行完毕")));
  check("task.status=done", service.task.status === "done");
  check("task logs captured", service.task.logs.length > 0);

  // ---- 5. /workspace
  console.log("\n[5] 工作目录切换");
  mock.state.inbound.push(userMsg("wxid_bound_user", "/workspace D:\\DSH"));
  await waitFor(() => (sent.some((s) => s.text.includes("工作目录已切换为")) ? true : null));
  check("workspace switched", service.workspace === "D:\\DSH", `got ${service.workspace}`);
  mock.state.inbound.push(userMsg("wxid_bound_user", "/workspace D:\\不存在的目录_xyz"));
  await waitFor(() => (sent.some((s) => s.text.includes("目录不存在")) ? true : null));
  check("invalid workspace rejected", service.workspace === "D:\\DSH");

  // ---- 6. /stop
  console.log("\n[6] 终止任务");
  mock.state.inbound.push(userMsg("wxid_bound_user", "开始一个很长的任务"));
  await sleep(300);
  mock.state.inbound.push(userMsg("wxid_bound_user", "/stop"));
  await waitFor(() => (sent.some((s) => s.text.includes("任务已终止")) ? true : null), 6000);
  check("task stopped", service.task.status === "stopped", `status=${service.task.status}`);

  // ---- 7. 图片消息
  console.log("\n[7] 图片消息转发");
  mock.state.inbound.push({
    from_user_id: "wxid_bound_user",
    to_user_id: "mock-account-1",
    message_type: 1,
    context_token: "ctx-img",
    item_list: [{ type: 2, image_item: { url: "https://example.com/a.jpg", media: { full_url: "https://example.com/a.jpg" } } }],
  });
  await waitFor(() => (sent.some((s) => s.text.includes("收到一张图片")) ? true : null));
  check("image forwarded", sent.some((s) => s.text.includes("收到一张图片")));

  // ---- 8. /unbind
  console.log("\n[8] 解绑");
  mock.state.inbound.push(userMsg("wxid_bound_user", "/unbind"));
  await waitFor(() => (sent.some((s) => s.text.includes("已解绑")) ? true : null));
  check("unbound", service.phase === "idle" && !service.bound);

  // ---- 9. 重新扫码（解绑后可重连）
  console.log("\n[9] 重新扫码");
  r = await service.start();
  check("restart ok", r.ok);
  await waitFor(() => (service.phase === "connected" ? true : null));
  check("reconnected", service.phase === "connected");

  service.dispose();
  await mock.stop();
  console.log(`\n结果: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
