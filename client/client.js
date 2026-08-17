/* dsh-wechat-link 客户端插件（浏览器/桌面内嵌 Web UI）。
 * 仅做 UI：右上角按钮 + 弹窗展示二维码/状态/使用说明。
 * 消息转发与 Agent 执行全部跑在本地后端（/api/wechat-link/* 同源接口），
 * 浏览器网页不处理任何消息业务。
 */
window.__ModuleLoader__.load({ id: "dsh-wechat-link", factory: (require) => {
  var module = { exports: {} };
  var exports = module.exports;

  var react = require("react");
  var createElement = react.createElement;
  var useState = react.useState;
  var useEffect = react.useEffect;
  var useRef = react.useRef;
  var useCallback = react.useCallback;

  var API = "/api/wechat-link";

  var CSS = [
    ".dshwl-btn{position:fixed;top:64px;right:18px;z-index:2147483000;display:flex;align-items:center;gap:6px;padding:7px 14px;border-radius:999px;border:1px solid rgba(128,128,128,.35);background:rgba(24,26,32,.82);color:#e8e8ea;font-size:13px;font-family:inherit;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.35);backdrop-filter:blur(6px);transition:transform .12s ease,background .12s ease}",
    ".dshwl-btn:hover{background:rgba(40,44,54,.95);transform:translateY(-1px)}",
    ".dshwl-btn .dshwl-dot{width:8px;height:8px;border-radius:50%;background:#3ddc84;flex:none}",
    ".dshwl-btn .dshwl-dot.err{background:#f5455c}",
    ".dshwl-mask{position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;animation:dshwlFade .15s ease}",
    "@keyframes dshwlFade{from{opacity:0}to{opacity:1}}",
    ".dshwl-modal{width:min(92vw,470px);max-height:88vh;overflow:auto;background:#17181d;color:#e8e8ea;border:1px solid rgba(128,128,128,.28);border-radius:14px;padding:18px 20px;box-shadow:0 12px 40px rgba(0,0,0,.5)}",
    ".dshwl-modal h2{margin:0 0 4px;font-size:16px;font-weight:600;display:flex;justify-content:space-between;align-items:center}",
    ".dshwl-close{background:none;border:none;color:#9a9aa0;font-size:18px;cursor:pointer;padding:2px 6px;border-radius:6px}",
    ".dshwl-close:hover{color:#fff;background:rgba(128,128,128,.2)}",
    ".dshwl-sub{color:#9a9aa0;font-size:12px;margin:0 0 12px}",
    ".dshwl-qr{width:240px;height:240px;margin:14px auto;border-radius:8px;background:#fff;padding:6px;display:flex;align-items:center;justify-content:center}",
    ".dshwl-qr img{width:228px;height:228px;image-rendering:pixelated}",
    ".dshwl-status{text-align:center;font-size:13px;margin:6px 0 10px;color:#cfcfd4}",
    ".dshwl-status .ok{color:#3ddc84}.dshwl-status .warn{color:#f5c344}.dshwl-status .err{color:#f5455c}",
    ".dshwl-banner{margin:8px 0 12px;padding:9px 12px;border-radius:8px;background:rgba(245,197,68,.12);border:1px solid rgba(245,197,68,.4);color:#f5c344;font-size:12.5px;line-height:1.5}",
    ".dshwl-usage{margin-top:12px;padding-top:10px;border-top:1px solid rgba(128,128,128,.2);font-size:12px;color:#b9b9c0;line-height:1.7}",
    ".dshwl-usage code{background:rgba(128,128,128,.18);padding:1px 5px;border-radius:4px;font-family:Consolas,Menlo,monospace;font-size:11.5px;color:#e8e8ea}",
    ".dshwl-actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}",
    ".dshwl-btn2{padding:7px 14px;border-radius:8px;border:1px solid rgba(128,128,128,.4);background:rgba(128,128,128,.12);color:#e8e8ea;font-size:12.5px;cursor:pointer}",
    ".dshwl-btn2:hover{background:rgba(128,128,128,.25)}",
    ".dshwl-btn2.primary{background:#1f6feb;border-color:#1f6feb}",
    ".dshwl-btn2.primary:hover{background:#2a7bf5}",
    ".dshwl-btn2.danger{color:#f5455c;border-color:rgba(245,69,92,.5)}",
    ".dshwl-log{font-family:Consolas,Menlo,monospace;font-size:11px;background:rgba(0,0,0,.35);border-radius:6px;padding:8px 10px;margin-top:8px;max-height:150px;overflow:auto;color:#b9b9c0;white-space:pre-wrap;word-break:break-all}",
    ".dshwl-task{font-size:12.5px;margin-top:8px;color:#cfcfd4}",
    ".dshwl-fields{font-size:12.5px;line-height:1.8;color:#cfcfd4}",
    ".dshwl-fields b{color:#e8e8ea}"
  ].join("");

  function phaseLabel(phase) {
    return { idle: "未连接", qr: "等待扫码", connected: "已连接", error: "连接异常" }[phase] || phase;
  }

  function taskLabel(s) {
    return { idle: "空闲", thinking: "🤔 正在思考", executing: "⚙️ 执行中", done: "✅ 执行完毕", error: "❌ 出错", stopped: "🛑 已终止" }[s] || s;
  }

  function fmtTs(ms) {
    if (!ms) return "";
    var s = Math.max(0, Math.floor((ms - Date.now()) / 1000));
    var m = Math.floor(s / 60);
    s = s % 60;
    return (m > 0 ? m + "分" : "") + s + "秒";
  }

  function Usage() {
    return createElement("div", { className: "dshwl-usage" },
      createElement("div", null, "📖 使用说明：扫码绑定后，在本微信会话中发送文字/图片，将由本机 DSH Agent 执行（可运行 cmd、git、读写项目文件）。"),
      createElement("div", null, "内置指令："),
      createElement("div", null, createElement("code", null, "/status"), " 查询连接状态"),
      createElement("div", null, createElement("code", null, "/workspace D:\\路径"), " 切换工作目录"),
      createElement("div", null, createElement("code", null, "/stop"), " 强制终止当前任务"),
      createElement("div", null, createElement("code", null, "/unbind"), " 解绑会话"),
      createElement("div", null, "默认工作目录：", createElement("code", null, "D:\\DSH\\G2"))
    );
  }

  function WechatLinkRoot() {
    var _s = useState(false);
    var open = _s[0], setOpen = _s[1];
    var _s2 = useState(null);
    var snap = _s2[0], setSnap = _s2[1];
    var _s3 = useState("loading");
    var err = _s3[0], setErr = _s3[1];
    var _s4 = useState(false);
    var busy = _s4[0], setBusy = _s4[1];
    var wasConnected = useRef(false);
    var prevPhase = useRef(null);
    var rev = useRef(0);

    var fetchStatus = useCallback(function () {
      fetch(API + "/status", { headers: { accept: "application/json" } })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)); })
        .then(function (data) {
          setSnap(data);
          setErr("");
          // 会话断开 → 自动弹出提示（连接过 → 现在既不是已连接也不是扫码中）
          if (data && prevPhase.current === "connected" && data.phase !== "connected" && data.phase !== "qr") {
            wasConnected.current = true;
            setOpen(true);
          }
          if (data && data.phase === "connected") wasConnected.current = true;
          prevPhase.current = data ? data.phase : null;
        })
        .catch(function (e) {
          setErr(String(e && e.message ? e.message : e));
        });
    }, []);

    useEffect(function () {
      fetchStatus();
      var t = setInterval(fetchStatus, 2000);
      return function () { clearInterval(t); };
    }, [fetchStatus]);

    // 二维码内容变化时更新图片缓存版本
    useEffect(function () {
      if (snap && snap.qrUrl) rev.current = rev.current + 1;
    }, [snap && snap.qrUrl]);

    var call = useCallback(function (path) {
      setBusy(true);
      fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data && data.snapshot !== undefined) { /* ignore */ }
          setSnap(data);
          if (data && data.ok === false) setErr(data.error || data.message || "操作失败");
          fetchStatus();
        })
        .catch(function (e) { setErr(String(e && e.message ? e.message : e)); })
        .finally(function () { setBusy(false); });
    }, [fetchStatus]);

    var connected = snap && snap.phase === "connected";
    var showDisconnect = wasConnected.current && snap && !connected && snap.phase !== "qr";
    var dotClass = "dshwl-dot" + (snap && snap.phase === "error" ? " err" : "");

    var btn = createElement("button", {
      className: "dshwl-btn",
      onClick: function () { setOpen(true); fetchStatus(); },
      title: "手机微信互联"
    },
      createElement("span", { className: dotClass }),
      createElement("span", null, "📱 手机微信互联")
    );

    var modal = null;
    if (open) {
      var content = [];
      if (err) {
        content.push(createElement("div", { className: "dshwl-banner", key: "err" }, "⚠️ 无法连接本地后端：" + err + "（请确认 dsh web 正在运行）"));
      }

      if (!snap || snap.phase === "idle" || snap.phase === "error") {
        content.push(createElement("div", { className: "dshwl-status", key: "idle" },
          createElement("span", { className: "warn" }, snap && snap.phase === "error" ? "⚠️ " + (snap.lastError || "连接异常") : "尚未连接微信"),
          snap && snap.lastError ? createElement("div", { className: "dshwl-sub", key: "errsub" }, snap.lastError) : null
        ));
        content.push(createElement("div", { className: "dshwl-actions", key: "act" },
          createElement("button", { className: "dshwl-btn2 primary", disabled: busy, onClick: function () { call(API + "/start"); } }, busy ? "请稍候…" : "🔄 开始扫码连接")
        ));
      } else if (snap.phase === "qr") {
        var remaining = snap.qrExpiresAt ? fmtTs(snap.qrExpiresAt) : "";
        var qrLabel =
          snap.qrStatus === "scaned" ? "✅ 已扫码，请在手机微信上确认…" :
          snap.qrStatus === "expired" ? "🔄 二维码已过期，正在自动刷新…" :
          snap.qrStatus === "need_verifycode" ? "需要验证码，正在更换二维码…" :
          "请使用手机微信扫描下方二维码";
        content.push(createElement("div", { className: "dshwl-qr", key: "qr" },
          createElement("img", { src: API + "/qr.png?t=" + rev.current, alt: "微信连接二维码", crossOrigin: "anonymous" })
        ));
        content.push(createElement("div", { className: "dshwl-status", key: "st" },
          createElement("span", { className: snap.qrStatus === "scaned" ? "ok" : "" }, qrLabel),
          remaining ? createElement("div", { className: "dshwl-sub", key: "left" }, "二维码有效剩余：" + remaining + "（超时自动刷新）") : null
        ));
        content.push(createElement("div", { className: "dshwl-actions", key: "act" },
          createElement("button", { className: "dshwl-btn2", disabled: busy, onClick: function () { call(API + "/refresh"); } }, "🔄 刷新二维码")
        ));
      } else if (connected) {
        content.push(createElement("div", { className: "dshwl-status", key: "st" },
          createElement("span", { className: "ok" }, "✅ 已连接")
        ));
        content.push(createElement("div", { className: "dshwl-fields", key: "f1" },
          createElement("div", null, "绑定账号：", createElement("b", null, snap.bound.userId || "—")),
          createElement("div", null, "工作目录：", createElement("b", null, snap.workspace || "—")),
          createElement("div", null, "任务状态：", createElement("b", null, taskLabel(snap.task && snap.task.status)))
        ));
        if (snap.task && snap.task.status !== "idle" && snap.task.logs && snap.task.logs.length) {
          content.push(createElement("div", { className: "dshwl-task", key: "t2" },
            "最近日志：" + snap.task.logs.slice(-5).map(function (l) { return l.text; }).join(" ｜ ")
          ));
          content.push(createElement("div", { className: "dshwl-log", key: "logs" },
            snap.task.logs.slice(-20).map(function (l) { return "[" + new Date(l.t).toLocaleTimeString() + "] " + l.text; }).join("\n")
          ));
        }
        content.push(createElement("div", { className: "dshwl-actions", key: "act" },
          createElement("button", {
            className: "dshwl-btn2 danger",
            disabled: busy,
            onClick: function () { if (window.confirm("确认解绑当前微信会话？")) call(API + "/unbind"); }
          }, "解绑会话")
        ));
      }

      if (showDisconnect) {
        content.unshift(createElement("div", { className: "dshwl-banner", key: "dc" },
          "⚠️ 微信会话已断开，请点击下方按钮重新扫码连接。"
        ));
      }

      content.push(createElement(Usage, { key: "usage" }));

      modal = createElement("div", { className: "dshwl-mask", onClick: function (e) { if (e.target === e.currentTarget) setOpen(false); } },
        createElement("div", { className: "dshwl-modal" },
          createElement("h2", null,
            createElement("span", null, "📱 手机微信互联"),
            createElement("button", { className: "dshwl-close", onClick: function () { setOpen(false); }, title: "关闭" }, "✕")
          ),
          createElement("p", { className: "dshwl-sub" }, "扫码绑定本人微信，远程遥控本机 DSH（无需公网 IP，本机端口不对公网开放）"),
          content
        )
      );
    }

    return createElement("div", null,
      createElement("style", null, CSS),
      btn,
      modal
    );
  }

  exports.name = "dsh-wechat-link";
  exports.inject = ["slots"];
  exports.apply = function apply(ctx) {
    if (!ctx || !ctx.slots) return;
    ctx.slots.inject("shell.overlay", function () {
      return ctx.slots.register({
        name: "shell.overlay",
        id: "dsh-wechat-link",
        label: function () { return "手机微信互联"; }
      }, WechatLinkRoot);
    });
  };

  return module.exports;
}});
