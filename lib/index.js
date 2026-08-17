// index.js — dsh-wechat-link 服务端插件入口。
// 独立 cordis 插件：挂载 /api/wechat-link/* 同源路由（dsh web 本身只监听 127.0.0.1，
// 不对外暴露任何端口），负责扫码登录、消息转发、Agent 任务执行。
"use strict";

import path from "node:path";
import fs from "node:fs";
import QRCode from "qrcode";

import { WechatLinkService } from "./state.js";
import { downloadImageBuffer } from "./cdn.js";
import * as ilink from "./ilink.js";
import { runAgentTask } from "./agent.js";

export const name = "dsh-wechat-link";

const API_PREFIX = "/api/wechat-link";

/** 同一来源校验：仅允许本机 dsh web 页面（或非浏览器请求）调用写操作。 */
function isSameOrigin(req, allowEmpty = true) {
  const origin = req.headers.origin;
  if (!origin) return allowEmpty;
  const host = req.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}"));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

function apply(ctx, config) {
  const service = new WechatLinkService({
    workspace: config?.workspace,
    host: {
      log: (msg) => {
        try {
          ctx.logger?.info?.(`[dsh-wechat-link] ${msg}`);
        } catch {
          /* 忽略 */
        }
      },
      sendText: (bound, text, contextToken) =>
        ilink.sendText({ baseUrl: bound.baseUrl, token: bound.token, toUserId: bound.userId, contextToken, text }),
      downloadImage: (imageItem) =>
        downloadImageBuffer(imageItem.media, imageItem).catch(() => null),
      runAgent: (opts) => {
        const svc = ctx.get("agents")
          ? {
              agents: ctx.get("agents"),
              agentDefaultModel: ctx.get("agentDefaultModel"),
              sessions: ctx.get("sessions"),
              agentPresets: ctx.get("agentPresets"),
            }
          : null;
        if (!svc) throw new Error("本地 DSH Agent 服务不可用（web profile 缺少 agents 服务）");
        return runAgentTask(svc, opts);
      },
    },
  });

  // 优雅退出：停止后台循环
  if (typeof ctx.on === "function") {
    ctx.on("dispose", () => service.dispose());
  }

  ctx.inject(["webServer"], (hostCtx) => {
    const register = (kind, suffix, handler) =>
      hostCtx.webServer.register({
        kind,
        path: suffix,
        handler: (req, res) => {
          handler(req, res).catch((err) => {
            try {
              sendJson(res, 500, { ok: false, error: String(err?.message ?? err) });
            } catch {
              /* 忽略 */
            }
          });
        },
      });

    hostCtx.effect(() => {
      const disposers = [
        register("exact", `${API_PREFIX}/status`, async (req, res) => {
          sendJson(res, 200, { ok: true, ...service.snapshot() });
        }),
        register("exact", `${API_PREFIX}/start`, async (req, res) => {
          if (!isSameOrigin(req)) return sendJson(res, 403, { ok: false, error: "forbidden" });
          const result = await service.start();
          sendJson(res, result.ok ? 200 : 500, { ok: result.ok, message: result.message, ...service.snapshot() });
        }),
        register("exact", `${API_PREFIX}/refresh`, async (req, res) => {
          if (!isSameOrigin(req)) return sendJson(res, 403, { ok: false, error: "forbidden" });
          const result = await service.refreshQr();
          sendJson(res, result.ok ? 200 : 500, { ok: result.ok, message: result.message, ...service.snapshot() });
        }),
        register("exact", `${API_PREFIX}/unbind`, async (req, res) => {
          if (!isSameOrigin(req)) return sendJson(res, 403, { ok: false, error: "forbidden" });
          const result = await service.unbind();
          sendJson(res, result.ok ? 200 : 500, { ok: result.ok, message: result.message, ...service.snapshot() });
        }),
        register("exact", `${API_PREFIX}/qr.png`, async (req, res) => {
          const snap = service.snapshot();
          if (snap.phase !== "qr" || !snap.qrUrl) {
            return sendJson(res, 404, { ok: false, error: "no qr" });
          }
          const png = await QRCode.toBuffer(snap.qrUrl, { width: 420, margin: 2 });
          res.writeHead(200, {
            "Content-Type": "image/png",
            "Content-Length": png.length,
            "Cache-Control": "no-store",
          });
          res.end(png);
        }),
      ];
      return () => disposers.forEach((d) => d());
    }, "dsh-wechat-link: http routes");
  });
}

export { apply, WechatLinkService };
