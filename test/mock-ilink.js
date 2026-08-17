// mock-ilink.js — 模拟腾讯 iLink Bot 网关，用于本地单元测试（不产生真实网络流量）。
"use strict";

import http from "node:http";

export function createMockIlink() {
  const state = {
    qrStatusSeq: [], // 队列：每次 get_qrcode_status 消费一个
    inbound: [], // getupdates 返回的消息队列
    outbound: [], // 捕获的 sendmessage
    updatesBuf: 0,
    notified: [],
    qrCount: 0,
  };

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://127.0.0.1");
      res.setHeader("Content-Type", "application/json");
      const send = (obj, status = 200) => {
        res.writeHead(status);
        res.end(JSON.stringify(obj));
      };
      if (req.method === "POST" && url.pathname === "/ilink/bot/get_bot_qrcode") {
        state.qrCount++;
        const qr = `qr-${state.qrCount}`;
        state.qr = qr;
        state.qrStatusSeq = ["wait", "scaned", "confirmed"];
        return send({ qrcode: qr, qrcode_img_content: `https://weixin.qq.com/l/connect?qr=${qr}` });
      }      if (req.method === "GET" && url.pathname === "/ilink/bot/get_qrcode_status") {
        const next = state.qrStatusSeq.length ? state.qrStatusSeq.shift() : "wait";
        if (next === "confirmed") {
          return send({
            status: "confirmed",
            bot_token: "mock-bot-token",
            ilink_bot_id: "mock-account-1",
            ilink_user_id: "wxid_bound_user",
            baseurl: `http://127.0.0.1:${server.address().port}`,
          });
        }
        return send({ status: next });
      }
      if (req.method === "POST" && url.pathname === "/ilink/bot/getupdates") {
        const parsed = JSON.parse(body || "{}");
        const buf = parsed.get_updates_buf || "";
        const msgs = state.inbound.splice(0, state.inbound.length);
        state.updatesBuf++;
        return send({ ret: 0, msgs, get_updates_buf: `buf-${state.updatesBuf}` });
      }
      if (req.method === "POST" && url.pathname === "/ilink/bot/sendmessage") {
        const parsed = JSON.parse(body || "{}");
        state.outbound.push(parsed.msg);
        return send({ ret: 0 });
      }
      if (req.method === "POST" && /\/ilink\/bot\/msg\/notify(start|stop)$/.test(url.pathname)) {
        state.notified.push(url.pathname.split("/").pop());
        return send({ ret: 0 });
      }
      send({ ret: -1, errmsg: `unexpected: ${req.method} ${url.pathname}` }, 404);
    });
  });

  const start = () =>
    new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

  const stop = () => new Promise((resolve) => server.close(resolve));

  return { state, start, stop, server };
}

/** 构造一条来自微信的用户消息。 */
export function userMsg(from, text, extra = {}) {
  return {
    from_user_id: from,
    to_user_id: "mock-account-1",
    message_type: 1,
    message_state: 0,
    context_token: "ctx-" + Math.random().toString(36).slice(2),
    item_list: [{ type: 1, text_item: { text } }],
    ...extra,
  };
}
