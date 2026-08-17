// state.js — 微信互联会话状态机：扫码登录、绑定、消息过滤、指令处理、任务调度。
// V2 回退版：单账号轮询（低延迟），保留「最终回答提取」与「standard 预设工具挂载」修复。
"use strict";

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import * as ilink from "./ilink.js";

export const DEFAULT_WORKSPACE = "D:\\DSH\\G2";

const QR_REFRESH_LIMIT = 3;
const UPDATES_RETRY_LIMIT = 5;

function defaultStateDir() {
  const base = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(base, "storages", "wechat-link");
}

function maskUser(id) {
  if (!id) return "";
  return id.length <= 8 ? id : `${id.slice(0, 4)}…${id.slice(-4)}`;
}

/**
 * 工作目录解析（跨机器兼容）：
 * 优先使用配置值（如 D:\DSH\G2）；不存在时回退到 dsh web 的当前目录（用户自己的工作目录）。
 */
function resolveWorkspace(configured) {
  const candidates = [configured, process.env.DSH_WORKSPACE, process.cwd()].filter(Boolean);
  for (const c of candidates) {
    try {
      if (c && fs.statSync(c).isDirectory()) return c;
    } catch {
      /* 不存在则尝试下一个 */
    }
  }
  return configured || process.cwd();
}

export class WechatLinkService {
  /**
   * @param {object} opts
   * @param {string} [opts.stateDir]
   * @param {string} [opts.workspace] 默认工作目录
   * @param {object} [opts.ilinkApi]  覆盖 ilink 客户端（测试用）
   * @param {object} opts.host        { sendText, runAgent, downloadImage, log }
   */
  constructor(opts) {
    this.stateDir = opts.stateDir ?? defaultStateDir();
    this.api = opts.ilinkApi ?? ilink;
    this.host = opts.host ?? {};
    this.log = opts.host.log ?? (() => {});
    this.listeners = new Set();

    this.phase = "idle"; // idle | qr | connected | error
    this.qr = null; // { url, code, expiresAt }
    this.qrStatus = "wait"; // wait | scaned | confirmed | expired | need_verifycode
    this.qrRefreshCount = 0;
    this.bound = null; // { userId, accountId, baseUrl, token, connectedAt }
    this.workspace = resolveWorkspace(opts.workspace);
    this.task = {
      status: "idle", // idle | thinking | executing | done | error | stopped
      title: "",
      logs: [],
      startedAt: 0,
      finishedAt: 0,
      error: "",
    };
    this.lastError = "";
    this._updatesBuf = "";
    this._contextToken = "";
    this._qrLoop = null;
    this._updatesLoop = null;
    this._qrRefreshTimer = null;
    this._running = false;
    this._taskController = null;
    // 测试可注入更短的轮询间隔
    this.pollDelayMs = opts.pollDelayMs ?? 1200;
    this.updatesDelayMs = opts.updatesDelayMs ?? 500;

    this._loadPersisted();
  }

  // ------------------------------------------------------------------ 基础

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit() {
    for (const fn of [...this.listeners]) {
      try {
        fn(this.snapshot());
      } catch (err) {
        this.log(`listener error: ${err}`);
      }
    }
  }

  /** 对外只读快照（供 HTTP API / UI 使用）。 */
  snapshot() {
    return {
      phase: this.phase,
      qrStatus: this.qrStatus,
      qrUrl: this.qr?.url ?? null,
      qrExpiresAt: this.qr?.expiresAt ?? null,
      bound: this.bound
        ? {
            userId: maskUser(this.bound.userId),
            accountId: this.bound.accountId,
            connectedAt: this.bound.connectedAt,
          }
        : null,
      workspace: this.workspace,
      task: { ...this.task, logs: this.task.logs.slice(-60) },
      lastError: this.lastError,
      ts: Date.now(),
    };
  }

  _persistPath() {
    return path.join(this.stateDir, "state.json");
  }

  _loadPersisted() {
    try {
      if (!fs.existsSync(this._persistPath())) return;
      const data = JSON.parse(fs.readFileSync(this._persistPath(), "utf-8"));
      if (data?.bound && data.bound.token) {
        this.bound = {
          userId: data.bound.userId ?? "",
          accountId: data.bound.accountId ?? "",
          baseUrl: data.bound.baseUrl ?? ilink.DEFAULT_BASE_URL,
          token: data.bound.token,
          connectedAt: data.bound.connectedAt ?? Date.now(),
        };
        this._updatesBuf = data.updatesBuf ?? "";
        if (data.workspace) this.workspace = data.workspace;
      }
    } catch (err) {
      this.log(`load persisted state failed: ${err}`);
    }
  }

  _savePersisted() {
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      const data = {
        bound: this.bound
          ? {
              userId: this.bound.userId,
              accountId: this.bound.accountId,
              baseUrl: this.bound.baseUrl,
              token: this.bound.token,
              connectedAt: this.bound.connectedAt,
            }
          : null,
        updatesBuf: this._updatesBuf,
        workspace: this.workspace,
      };
      const tmp = `${this._persistPath()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
      fs.renameSync(tmp, this._persistPath());
      try {
        fs.chmodSync(this._persistPath(), 0o600);
      } catch {
        /* 尽力而为 */
      }
    } catch (err) {
      this.log(`save persisted state failed: ${err}`);
    }
  }

  _setPhase(phase) {
    this.phase = phase;
    if (phase !== "qr") this.qrStatus = "wait";
    this._emit();
  }

  // ------------------------------------------------------------------ 登录

  /**
   * 开始扫码登录。已连接则直接返回当前状态；已有未过期二维码则复用。
   */
  async start() {
    if (this.phase === "connected") return { ok: true, message: "已连接" };
    if (this.phase === "qr" && this.qr && this.qr.expiresAt > Date.now()) {
      return { ok: true, message: "二维码已生成，请扫码" };
    }
    try {
      const localTokenList = this.bound?.token ? [this.bound.token] : [];
      const { qrcode, qrcodeUrl } = await this.api.fetchQrCode({ localTokenList });
      this.qr = { code: qrcode, url: qrcodeUrl, expiresAt: Date.now() + ilink.QR_TTL_MS };
      this.qrStatus = "wait";
      this.qrRefreshCount = 0;
      this.lastError = "";
      this._setPhase("qr");
      this._startQrLoop();
      return { ok: true, message: "二维码已生成，请用手机微信扫码" };
    } catch (err) {
      this.lastError = `获取二维码失败: ${err?.message ?? err}`;
      this._setPhase("error");
      return { ok: false, message: this.lastError };
    }
  }

  /** 手动刷新二维码。 */
  async refreshQr() {
    if (this.phase !== "qr" && this.phase !== "idle" && this.phase !== "error") {
      return { ok: false, message: "当前状态无需刷新二维码" };
    }
    try {
      const localTokenList = this.bound?.token ? [this.bound.token] : [];
      const { qrcode, qrcodeUrl } = await this.api.fetchQrCode({ localTokenList });
      this.qr = { code: qrcode, url: qrcodeUrl, expiresAt: Date.now() + ilink.QR_TTL_MS };
      this.qrStatus = "wait";
      this.qrRefreshCount = 0;
      this.lastError = "";
      this._setPhase("qr");
      this._startQrLoop();
      return { ok: true, message: "二维码已刷新" };
    } catch (err) {
      this.lastError = `刷新二维码失败: ${err?.message ?? err}`;
      this._setPhase("error");
      return { ok: false, message: this.lastError };
    }
  }

  _startQrLoop() {
    if (this._qrLoop) return;
    this._qrLoop = (async () => {
      while (this.phase === "qr") {
        // 超时自动刷新
        if (this.qr && this.qr.expiresAt <= Date.now()) {
          if (this.qrRefreshCount >= QR_REFRESH_LIMIT) {
            this.lastError = "二维码多次过期，请点击重新扫码";
            this._setPhase("error");
            break;
          }
          this.qrRefreshCount++;
          this.qrStatus = "expired";
          this._emit();
          try {
            const localTokenList = this.bound?.token ? [this.bound.token] : [];
            const { qrcode, qrcodeUrl } = await this.api.fetchQrCode({ localTokenList });
            this.qr = { code: qrcode, url: qrcodeUrl, expiresAt: Date.now() + ilink.QR_TTL_MS };
            this.qrStatus = "wait";
            this.log(`QR refreshed (${this.qrRefreshCount}/${QR_REFRESH_LIMIT})`);
            this._emit();
          } catch (err) {
            this.lastError = `刷新二维码失败: ${err?.message ?? err}`;
            this._setPhase("error");
            break;
          }
        }

        const status = await this.api.pollQrStatus({
          baseUrl: ilink.DEFAULT_BASE_URL,
          qrcode: this.qr.code,
        });
        if (this.phase !== "qr") break;

        switch (status.status) {
          case "scaned":
            if (this.qrStatus !== "scaned") {
              this.qrStatus = "scaned";
              this._emit();
            }
            break;
          case "confirmed":
            this._onConfirmed(status);
            return;
          case "binded_redirect":
            // 已绑定过本实例：保留本地凭证继续使用
            this._onConfirmed(status, true);
            return;
          case "scaned_but_redirect":
            // IDC 重定向，下一轮用新 host 轮询
            if (status.redirect_host) {
              this.qrStatus = "scaned";
              this._emit();
            }
            break;
          case "need_verifycode":
            // 需要配对码：无法在无绑定状态下与用户交互，自动换新二维码
            this.qrStatus = "need_verifycode";
            this.qr.expiresAt = 0; // 触发自动刷新
            this._emit();
            break;
          case "expired":
            this.qrStatus = "expired";
            this.qr.expiresAt = 0; // 触发自动刷新
            this._emit();
            break;
          default:
            break; // wait
        }
        await new Promise((r) => setTimeout(r, this.pollDelayMs));
      }
    })();
    this._qrLoop.finally(() => {
      this._qrLoop = null;
    });
  }

  _onConfirmed(status, alreadyConnected = false) {
    const botToken = status.bot_token;
    const accountId = status.ilink_bot_id;
    const userId = status.ilink_user_id ?? "";
    const baseUrl = status.baseurl || (this.bound?.baseUrl ?? ilink.DEFAULT_BASE_URL);

    if (!alreadyConnected && (!botToken || !accountId)) {
      this.lastError = "登录确认但缺少 bot_token / ilink_bot_id";
      this._setPhase("error");
      return;
    }

    this.bound = {
      userId,
      accountId: accountId ?? this.bound?.accountId ?? "",
      baseUrl,
      token: botToken ?? this.bound?.token,
      connectedAt: Date.now(),
    };
    this._updatesBuf = "";
    this._savePersisted();
    this._setPhase("connected");
    this._startUpdatesLoop();
    this.api.notify?.({ baseUrl, token: this.bound.token, kind: "start" });
    this.log(`WeChat connected, bound user=${maskUser(userId)} account=${accountId}`);
    if (this.host.sendText) {
      const name = alreadyConnected ? "（此前已连接，自动续连）" : "";
      this.host.sendText(this.bound, `✅ 微信互联成功${name}！\n已绑定本机 DSH，默认工作目录：\n${this.workspace}\n\n发送 /status 查看状态，/workspace 路径 切换目录，/stop 终止任务，/unbind 解绑。`).catch((err) => {
        this.log(`welcome send failed: ${err}`);
      });
    }
  }

  // ------------------------------------------------------------------ 消息接收

  _startUpdatesLoop() {
    if (this._updatesLoop) return;
    this._updatesLoop = (async () => {
      let retries = 0;
      while (this.phase === "connected" && this.bound?.token) {
        try {
          const resp = await this.api.getUpdates({
            baseUrl: this.bound.baseUrl,
            token: this.bound.token,
            getUpdatesBuf: this._updatesBuf,
          });
          if (this.phase !== "connected") break;
          retries = 0;
          if (resp?.get_updates_buf) this._updatesBuf = resp.get_updates_buf;
          if (resp?.errcode === -14) {
            // 会话超时 → 断开，需要重新扫码
            this.lastError = "微信会话已过期，请重新扫码连接";
            this._setPhase("error");
            this.api.notify?.({ baseUrl: this.bound.baseUrl, token: this.bound.token, kind: "stop" });
            break;
          }
          for (const msg of resp?.msgs ?? []) {
            try {
              await this._handleIncoming(msg);
            } catch (err) {
              this.log(`handle msg failed: ${err}`);
            }
          }
        } catch (err) {
          retries++;
          this.log(`getUpdates error (${retries}): ${err?.message ?? err}`);
          if (retries >= UPDATES_RETRY_LIMIT) {
            this.lastError = `微信连接中断: ${err?.message ?? err}`;
            this._setPhase("error");
            break;
          }
        }
        await new Promise((r) => setTimeout(r, this.updatesDelayMs));
      }
    })();
    this._updatesLoop.finally(() => {
      this._updatesLoop = null;
    });
  }

  /**
   * 处理一条微信消息。
   * 安全硬性限制：只处理本次扫码的本人微信账号（bound.userId）消息，
   * 其他用户消息一律直接丢弃。
   */
  async _handleIncoming(msg) {
    const fromId = msg?.from_user_id;
    if (!fromId) return;
    // 只处理绑定账号本人的消息；其余（群消息、他人私聊）直接丢弃
    if (this.bound?.userId && fromId !== this.bound.userId) {
      this.log(`drop message from ${maskUser(fromId)} (not bound user)`);
      return;
    }
    // 只处理用户消息（1=USER），忽略机器人消息回显
    if (msg?.message_type && msg.message_type !== 1) return;

    // 记住会话上下文令牌，回复时回传（iLink 协议要求）
    if (msg.context_token) this._contextToken = msg.context_token;

    const { text, image } = ilink.extractMessageContent(msg);
    if (!text && !image) return;

    if (text?.startsWith("/")) {
      await this._handleCommand(text.trim());
      return;
    }

    // 普通消息 → 本地 DSH Agent（不阻塞消息接收循环，/stop 等指令可随时插入）
    this._runTask({ text, image, contextToken: msg.context_token }).catch((err) =>
      this.log(`task dispatch failed: ${err}`),
    );
  }

  async _handleCommand(raw) {
    const [cmd, ...rest] = raw.split(/\s+/);
    const arg = rest.join(" ").trim();
    const bound = this.bound;
    const ctxToken = this._contextToken;
    const send = (t) => this.host.sendText?.(bound, t, ctxToken).catch((err) => this.log(`send failed: ${err}`));

    switch (cmd.toLowerCase()) {
      case "/status": {
        const t = this.task;
        const taskLine =
          t.status === "idle"
            ? "无进行中任务"
            : `任务: ${t.title || "—"}\n状态: ${this._taskLabel(t.status)}\n最近日志: ${t.logs
                .slice(-3)
                .map((l) => l.text)
                .join(" | ") || "无"}`;
        await send(
          `📡 微信互联状态\n` +
            `• 连接: ${this.phase === "connected" ? "✅ 已连接" : this.phase === "qr" ? "⏳ 等待扫码" : `⚠️ ${this.phase}`}\n` +
            `• 绑定账号: ${this.bound?.userId ? maskUser(this.bound.userId) : "未绑定"}\n` +
            `• 工作目录: ${this.workspace}\n` +
            `• ${taskLine}\n` +
            (this.lastError ? `• 最近错误: ${this.lastError}\n` : ""),
        );
        break;
      }
      case "/unbind": {
        const who = this.bound?.userId ? maskUser(this.bound.userId) : "";
        const boundNow = this.bound;
        this.bound = null;
        this._updatesBuf = "";
        this._savePersisted();
        this._setPhase("idle");
        // 用解绑前的 bound 发最后一条回复（bound 已清空）
        await this.host.sendText?.({ ...boundNow, userId: boundNow?.userId ?? "" }, `🔓 已解绑${who ? `（${who}）` : ""}。\n如需重新连接，请在 DSH 界面点击【手机微信互联】重新扫码。`, this._contextToken).catch((err) => this.log(`send failed: ${err}`));
        this.log("unbound by user");
        break;
      }
      case "/workspace": {
        if (!arg) {
          await send(`当前工作目录：\n${this.workspace}\n用法：/workspace D:\\path\\to\\dir`);
          break;
        }
        const resolved = arg.startsWith('"') && arg.endsWith('"') ? arg.slice(1, -1) : arg;
        try {
          const st = fs.statSync(resolved);
          if (!st.isDirectory()) {
            await send(`❌ ${resolved} 不是目录`);
            break;
          }
          this.workspace = resolved;
          this._savePersisted();
          await send(`✅ 工作目录已切换为：\n${this.workspace}`);
        } catch {
          await send(`❌ 目录不存在或无法访问：${resolved}`);
        }
        break;
      }
      case "/stop": {
        if (this._taskController) {
          this._taskController.abort();
          await send("🛑 正在终止当前任务…");
        } else {
          await send("当前没有正在执行的任务。");
        }
        break;
      }
      case "/help":
      case "/start": {
        await send(
          `🤖 DSH 微信遥控指令：\n` +
            `/status - 查询连接状态\n` +
            `/workspace D:\\path - 切换工作目录\n` +
            `/stop - 终止当前任务\n` +
            `/unbind - 解绑会话\n\n` +
            `直接发送文字/图片即可交给本地 DSH Agent 执行。`,
        );
        break;
      }
      default:
        await send(`未知指令：${cmd}\n发送 /help 查看可用指令。`);
        break;
    }
  }

  _taskLabel(s) {
    return { idle: "空闲", thinking: "🤔 正在思考", executing: "⚙️ 执行中", done: "✅ 执行完毕", error: "❌ 出错", stopped: "🛑 已终止" }[s] ?? s;
  }

  // ------------------------------------------------------------------ 任务

  async _runTask({ text, image, contextToken }) {
    if (this._running) {
      this.host.sendText?.(this.bound, "⚠️ 上一条任务还在执行中，请稍候（可用 /stop 终止）。").catch(() => {});
      return;
    }
    this._running = true;
    const controller = new AbortController();
    this._taskController = controller;
    this.task = {
      status: "thinking",
      title: text?.slice(0, 60) || (image ? "[图片]" : ""),
      logs: [],
      startedAt: Date.now(),
      finishedAt: 0,
      error: "",
    };
    this._emit();

    // 任务内固定使用本次消息的上下文令牌，避免任务执行期间被其它消息覆盖
    const bound = this.bound;
    const ctxToken = contextToken ?? this._contextToken;
    const send = (t) => this.host.sendText?.(bound, t, ctxToken).catch((err) => this.log(`send failed: ${err}`));
    await send(`🤔 收到任务，正在思考…\n${text ? text.slice(0, 100) : "📷 收到一张图片"}`);

    try {
      let prompt = text || "";
      if (image) {
        // 下载图片到工作目录下的 wechat-inbox/
        const inbox = path.join(this.workspace, "wechat-inbox");
        fs.mkdirSync(inbox, { recursive: true });
        const ext = ".jpg";
        const target = path.join(inbox, `wx-${Date.now()}${ext}`);
        try {
          const buf = await this.host.downloadImage?.(image);
          if (buf && buf.length > 0) {
            fs.writeFileSync(target, buf);
            prompt = `${prompt ? prompt + "\n" : ""}用户发送了一张图片，已保存到本地：${target}\n请查看该图片并按要求处理（若是图片识别/描述/编辑任务）。`.trim();
          } else {
            prompt = `${prompt ? prompt + "\n" : ""}用户发送了一张图片（下载失败，图片地址：${image.downloadUrl ?? "未知"}）`.trim();
          }
        } catch (err) {
          this.log(`image download failed: ${err}`);
          prompt = `${prompt ? prompt + "\n" : ""}用户发送了一张图片（下载失败：${err?.message ?? err}，地址：${image.downloadUrl ?? "未知"}）`.trim();
        }
      }
      if (!prompt) {
        await send("⚠️ 未识别到消息内容。");
        return;
      }

      // 直接以用户原文作为任务。工作目录通过 agent meta.cwd 注入；
      // 系统提示词由 profile 自带的 dsh-system-prompt 组装，不在此伪造。
      this.task.status = "executing";
      this._emit();

      let lastSent = 0;
      const result = await this.host.runAgent({
        prompt,
        workspace: this.workspace,
        signal: controller.signal,
        onLog: (line) => {
          this.task.logs.push({ t: Date.now(), level: line.level, text: line.text });
          this._emit();
          // 每 8 秒给微信发一次执行中摘要
          if (Date.now() - lastSent > 8000) {
            lastSent = Date.now();
            const tail = this.task.logs.slice(-2).map((l) => l.text).join("；");
            send(`⚙️ 执行中… ${tail ? tail.slice(0, 120) : ""}`).catch(() => {});
          }
        },
      });

      if (controller.signal.aborted) {
        this.task.status = "stopped";
        await send(`🛑 任务已终止。\n工作目录：${this.workspace}`);
      } else if (result?.error) {
        this.task.status = "error";
        this.task.error = result.error;
        await send(`❌ 任务执行出错：\n${result.error.slice(0, 500)}`);
      } else {
        this.task.status = "done";
        const summary = result?.text?.trim() || "（无文本输出）";
        await send(`✅ 执行完毕：\n${summary.slice(0, 1800)}`);
      }
    } catch (err) {
      this.task.status = "error";
      this.task.error = String(err?.message ?? err);
      this.log(`task failed: ${err}`);
      await send(`❌ 任务执行异常：\n${String(err?.message ?? err).slice(0, 500)}`);
    } finally {
      this.task.finishedAt = Date.now();
      this._taskController = null;
      this._running = false;
      this._emit();
    }
  }

  // ------------------------------------------------------------------ 解绑 / 停止

  async unbind() {
    const had = this.bound;
    this.bound = null;
    this._updatesBuf = "";
    this._savePersisted();
    this._setPhase("idle");
    if (had) {
      this.api.notify?.({ baseUrl: had.baseUrl, token: had.token, kind: "stop" });
    }
    return { ok: true, message: had ? "已解绑" : "当前未绑定" };
  }

  /** 停止所有后台循环（进程退出时调用）。 */
  dispose() {
    this._setPhase("idle");
    if (this.bound?.token) {
      this.api.notify?.({ baseUrl: this.bound.baseUrl, token: this.bound.token, kind: "stop" });
    }
    this._taskController?.abort();
  }
}
