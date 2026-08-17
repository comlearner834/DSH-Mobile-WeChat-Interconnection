// ilink.js — 腾讯 iLink Bot 协议客户端（openclaw-weixin 同款 HTTP JSON API）。
// 纯 Node fetch 实现，不依赖 openclaw 框架。所有请求都是**出站**连接，
// 本机不开放任何端口，全程不需要公网 IP。
//
// 端点（baseUrl 默认 https://ilinkai.weixin.qq.com）：
//   POST ilink/bot/get_bot_qrcode?bot_type=3     -> 获取登录二维码
//   GET  ilink/bot/get_qrcode_status?qrcode=..   -> 长轮询扫码状态
//   POST ilink/bot/getupdates                     -> 长轮询拉取新消息
//   POST ilink/bot/sendmessage                    -> 发送消息
//   POST ilink/bot/msg/notifystart|notifystop     -> 上下线通知
"use strict";

import crypto from "node:crypto";

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const DEFAULT_ILINK_BOT_TYPE = "3";
export const ILINK_APP_ID = "bot"; // 与官方 openclaw-weixin 包一致
const APP_VERSION = "0.1.0";

/** 二维码有效时长（与 openclaw 的 ACTIVE_LOGIN_TTL_MS 一致） */
export const QR_TTL_MS = 5 * 60_000;
/** 扫码状态长轮询超时 */
const QR_POLL_TIMEOUT_MS = 35_000;
/** getUpdates 长轮询默认超时 */
const UPDATES_POLL_TIMEOUT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;

function buildClientVersion(version) {
  const parts = version.split(".").map((p) => parseInt(p, 10) || 0);
  return ((parts[0] & 0xff) << 16) | ((parts[1] & 0xff) << 8) | (parts[2] & 0xff);
}

function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function ensureSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

function commonHeaders() {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(buildClientVersion(APP_VERSION)),
  };
}

function headersWithToken(token) {
  const h = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    ...commonHeaders(),
  };
  if (token && String(token).trim()) h.Authorization = `Bearer ${String(token).trim()}`;
  return h;
}

async function postJson(baseUrl, endpoint, body, { token, timeoutMs } = {}) {
  const url = new URL(endpoint, ensureSlash(baseUrl));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? API_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url.toString(), {
      method: "POST",
      headers: headersWithToken(token),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") throw new Error(`request timeout: ${endpoint}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`${endpoint} HTTP ${res.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    return { ret: -1, errmsg: text.slice(0, 200) };
  }
}

async function getText(baseUrl, endpoint, { timeoutMs } = {}) {
  const url = new URL(endpoint, ensureSlash(baseUrl));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? API_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url.toString(), {
      method: "GET",
      headers: { ...commonHeaders() },
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") throw new Error(`request timeout: ${endpoint}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`${endpoint} HTTP ${res.status}: ${text.slice(0, 200)}`);
  return text;
}

/**
 * 获取登录二维码。localTokenList 传入本地已有 bot token，
 * 服务端会把二维码直接绑定到该 token 对应的微信账号（免二次扫码）。
 */
export async function fetchQrCode({ baseUrl = DEFAULT_BASE_URL, botType = DEFAULT_ILINK_BOT_TYPE, localTokenList = [] } = {}) {
  const raw = await postJson(baseUrl, `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, {
    local_token_list: localTokenList,
  }, { timeoutMs: API_TIMEOUT_MS });
  const qrcode = raw?.qrcode;
  const qrcodeUrl = raw?.qrcode_img_content;
  if (!qrcode || !qrcodeUrl) throw new Error(`get_bot_qrcode 返回异常: ${JSON.stringify(raw).slice(0, 200)}`);
  return { qrcode, qrcodeUrl };
}

/**
 * 长轮询扫码状态。超时/网络错误视为 wait（继续轮询）。
 * 返回 { status, bot_token?, ilink_bot_id?, ilink_user_id?, baseurl?, redirect_host? }
 */
export async function pollQrStatus({ baseUrl, qrcode, verifyCode } = {}) {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
  try {
    const raw = await getText(baseUrl, endpoint, { timeoutMs: QR_POLL_TIMEOUT_MS });
    return JSON.parse(raw);
  } catch (err) {
    if (err?.name === "AbortError" || /timeout/.test(String(err))) {
      return { status: "wait" };
    }
    // 网关超时（Cloudflare 524 等）视为等待状态继续轮询
    return { status: "wait" };
  }
}

/**
 * 长轮询拉取新消息。
 * @returns {Promise<{ret:number, errcode?:number, errmsg?:string, msgs:any[], get_updates_buf:string}>}
 */
export async function getUpdates({ baseUrl, token, getUpdatesBuf = "" }) {
  try {
    const resp = await postJson(baseUrl, "ilink/bot/getupdates", {
      get_updates_buf: getUpdatesBuf,
      base_info: { channel_version: APP_VERSION, bot_agent: "DSH-WechatLink/0.1.0" },
    }, { token, timeoutMs: UPDATES_POLL_TIMEOUT_MS });
    return resp ?? { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
  } catch (err) {
    if (err?.name === "AbortError" || /timeout/.test(String(err))) {
      // 长轮询超时是正常控制流
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw err;
  }
}

/** 发送一条文本消息给指定用户。 */
export async function sendText({ baseUrl, token, toUserId, contextToken, text }) {
  const resp = await postJson(baseUrl, "ilink/bot/sendmessage", {
    msg: {
      to_user_id: toUserId,
      ...(contextToken ? { context_token: contextToken } : {}),
      item_list: [{ type: 1, text_item: { text } }],
    },
    base_info: { channel_version: APP_VERSION, bot_agent: "DSH-WechatLink/0.1.0" },
  }, { token, timeoutMs: API_TIMEOUT_MS });
  if (resp?.ret && resp.ret !== 0) throw new Error(`sendMessage ret=${resp.ret} errmsg=${resp.errmsg ?? ""}`);
  return resp;
}

/** 上线/下线通知（尽力而为）。 */
export async function notify({ baseUrl, token, kind = "start" } = {}) {
  try {
    await postJson(baseUrl, `ilink/bot/msg/notify${kind}`, {
      base_info: { channel_version: APP_VERSION, bot_agent: "DSH-WechatLink/0.1.0" },
    }, { token, timeoutMs: 8000 });
  } catch {
    /* 非关键，忽略 */
  }
}

/**
 * 从消息对象中提取纯文本内容（合并所有 text_item）。
 * 图片/文件消息返回 { imageUrl } 等字段。
 */
export function extractMessageContent(msg) {
  const textParts = [];
  let image = null;
  let file = null;
  for (const item of msg?.item_list ?? []) {
    if (item?.type === 1 && item?.text_item?.text) textParts.push(item.text_item.text);
    else if (item?.type === 2 && item?.image_item) {
      image = item.image_item;
      // url / full_url / media.encrypt_query_param 均可用于下载
      image.downloadUrl = item.image_item.url || item.image_item.media?.full_url || item.image_item.media?.encrypt_query_param || null;
    } else if (item?.type === 4 && item?.file_item) {
      file = item.file_item;
    }
  }
  return { text: textParts.join("\n"), image, file };
}
