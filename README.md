# 📱 dsh-wechat-link — DSH 手机微信互联插件

> 用手机微信扫码绑定本机 DeepSeek Harness（DSH），在微信里直接遥控本地 Agent：
> 执行 cmd 命令、git 操作、读写修改项目文件，任务状态与日志实时回传微信。
>
> 独立插件模块，**不修改 DSH 任何核心代码**；基于腾讯 **iLink Bot 协议**，
> **无需公网 IP，本机不对外开放任何端口**（全部为出站连接）。

---

## ✨ 功能

- 桌面端与浏览器 Web 版右上角均出现【📱 手机微信互联】按钮，弹窗内展示二维码
- 扫码确认后自动绑定**本人微信**，默认工作目录可用 `/workspace` 切换
- 微信发送**文字 / 图片** → 转发给本地 DSH Agent 执行（可运行 cmd、git、读写项目文件）
- 任务阶段实时回传：🤔 正在思考 → ⚙️ 执行中 → ✅ 执行完毕 / ❌ 出错，含运行日志
- 二维码超时自动刷新；断线自动提示；支持重新扫码重连
- 🔒 **安全硬性限制：只处理本次扫码的本人微信账号消息，其他用户消息一律丢弃**

## 🚀 快速上手（三种安装方式，任选其一）

### 方式一：Release 安装包（推荐给普通用户）
1. 打开本仓库 **Releases** 页面，下载最新的 `dsh-wechat-link-vX.Y.Z.zip`
2. 解压到任意位置 → **双击「双击安装.bat」**（无需安装 Node/npm，依赖已随包自带）
3. **完全退出并重新打开 DSH 桌面客户端** → 点右上角【📱 手机微信互联】→ 扫码即可使用

### 方式二：终端一行命令安装（推荐给喜欢命令行的用户）
在 PowerShell 里粘贴执行（会自动下载最新 Release 并安装）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/comlearner834/dsh-wechat-link/main/install-remote.ps1 | iex"
```

（也可本地运行 `install-remote.ps1`）

### 方式三：DSH 插件 CLI（进阶）
已安装 dsh CLI 的用户：

```bash
dsh plugin --profile web add github:comlearner834/dsh-wechat-link
```

---

> 💡 安装采用"复制"方式，**装完后下载文件夹可随意移动/删除**，不影响使用。
> 卸载：运行 `uninstall.ps1`（或删掉 DSH profile 中 `node_modules\dsh-wechat-link` 并移除 bundle 记录）。

## 💬 微信内置指令

| 指令 | 说明 |
|------|------|
| `/status` | 查询连接状态（账号/工作目录/任务状态） |
| `/workspace D:\路径` | 切换工作目录 |
| `/stop` | 强制终止正在执行的本地任务 |
| `/unbind` | 解绑会话 |
| `/help` | 查看指令说明 |

## 🧩 适配各版本

- **DSH ≥ 0.1.0-rc.4**（`dsh web` 均可使用；安装脚本自动检测 profile）
- Agent 工具（cmd/git/文件操作）依赖 DSH 的 `standard` agent 预设（rc.6+ 内置）；
  旧版本缺少该预设时自动降级为"无工具回答"，不影响消息收发
- 服务端按需获取 `agents` / `sessions` / `agentPresets` 等服务，缺失时优雅降级并回传错误信息
- 客户端插件使用 DSH 官方 `dsh.client`（`__ModuleLoader__`）机制，跨版本稳定
- 工作目录：默认使用配置值（`D:\DSH\G2`），不存在时自动回退到 `dsh web` 的当前目录

## 🔧 工作原理（安全说明）

- 通过腾讯 iLink Bot 网关（`ilinkai.weixin.qq.com`）以**出站长轮询**收发消息，
  **不需要公网 IP，不监听任何对外端口**（DSH web 本身也只绑定 127.0.0.1）
- 只处理与"本次扫码确认"绑定的微信账号消息；群消息、他人私聊一律丢弃
- Agent 在 DSH 的沙箱策略（workspace-write + approval）下执行，越界操作会被拒绝

## 📁 目录结构

```
dsh-wechat-link/
├── install.ps1        # Windows 一键安装（链接进 DSH profile + 注册 bundle）
├── uninstall.ps1      # 卸载
├── package.json       # npm 包声明（dsh.bundle.patch + dsh.client）
├── cordis.patch.yml   # 向 DSH profile 插入插件条目
├── lib/               # 服务端（协议客户端 / 状态机 / Agent 执行器 / CDN 图片）
│   ├── index.js       #   cordis 插件入口（/api/wechat-link/* 同源路由）
│   ├── ilink.js       #   iLink Bot 协议客户端
│   ├── state.js       #   会话状态机（绑定/过滤/指令/任务）
│   ├── agent.js       #   本地 DSH Agent 执行器
│   └── cdn.js         #   微信图片 CDN 下载与解密
├── client/
│   └── client.js      # 客户端插件（右上角按钮 + 二维码弹窗）
└── test/              # 单元测试（mock iLink 网关）
```

## 🧪 开发 / 测试

```bash
npm install
npm test          # 状态机 19 项 + 提取 7 项 + 客户端契约检查
```

## ❓ 常见问题

- **扫码后微信收不到任何消息（包括"✅ 微信互联成功"）**：腾讯 iLink 的 **ClawBot 灰度入口**
  未对当前微信账号开放（需最新版微信 + 灰度资格），服务端接受了发送但微信端不显示。
  这是腾讯侧限制，与插件无关。
- **每次重启都要重新扫码**：默认保留连接记录自动续连；若需强制重扫，在微信发 `/unbind`。
- **微信回复了但没有反应**：确认回复的会话是**本次扫码**对应的机器人会话
  （多次扫码会在微信里产生多个机器人入口，旧入口的消息不会到达当前账号）。
- **Agent 不执行命令**：确认 DSH 版本为 rc.6+（包含 `standard` agent 预设）；
  或查看 DSH 界面右上角弹窗中的连接状态与错误信息。

## 📄 License

[MIT](./LICENSE)
