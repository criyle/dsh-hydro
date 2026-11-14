# dsh-hydro 设计文档

> HydroOJ 的 DSH 运维/站点插件。本文描述**当前实现**：模块边界、远端交互、数据模型、工具与 UI。

## 1. 能力范围

| 能力 | 实现 |
| --- | --- |
| SSH 主机，密钥优先；首次密码只用于安装托管密钥 + 配置免密 sudo | `src/ssh/`、`src/service/connection.ts`；`AccountStore` 持久化 |
| 一键安装 Hydro（root / sudo / su） | `src/hydro/install.ts`，官方 `https://hydro.ac/setup.sh`，SSE 实时输出 |
| 状态、版本、升级、服务、pm2 日志 | `status.ts`、`versions.ts`、`upgrade.ts`、`logs.ts`；按包升级与 Nix 组件升级分开 |
| 安装形态识别与组件门禁 | `detect.ts` 输出 `installMode`（web/judge/web+judge）与 caddy/mongo/judge/sandbox 组件；网页功能在 judge-only 主机上显示不可用，Caddy/MongoDB/Judge 页按实际安装状态降级 |
| 独立评测机配置 | `judge-config.ts`：读取/备份/保存 `~/.hydro/judge.yaml` 并重启 hydrojudge |
| 排队诊断 | stale record 只统计超过 10 分钟仍在途的记录；支持最多 50 条一键 rejudge |
| 插件/addon 管理 | `plugins.ts`：`yarn global` + `hydrooj addon add/remove`，列表带版本/启用状态 |
| Caddy 配置管理 | `caddy.ts`：优先官方 `~/.hydro/Caddyfile`，校验、备份、重载 |
| Nix 维护 | `nix.ts`：Node/go-judge 升级、mirror 预设（官方/Hydro/USTC/TUNA/自定义） |
| 指标与排障 | `metrics.ts`、`issues`/`fixes.ts`、`logs.ts`；队列取真实 `task` 集合 |
| 站点管理 | `src/site/`：独立 站点账号、域、题库 ZIP、题目/比赛/域公告与权限 |
| 社区互动 | `src/community/`：只读轮询讨论，手动批准回复、AI 草稿 |
| 内嵌浏览 | `src/ops/proxy.ts`：loopback 反代远端 Caddy :80，浏览器登录并捕获 sid，HTTP/WS，导航 shim |
| 上下文 AI | `/hosts/context` 追踪内嵌页面；prompt 带 pid/tid/域；聊天里先在可编辑指令框输入 |

## 2. 架构

```
DSH Web (React client)
  └─ /dsh-hydro/api/v1/*  (JSON / SSE)
DSH Host (cordis plugin)
  ├─ AccountStore / SiteStore / UiSettingsStore
  ├─ HydroOps（SSH 连接池 + Hydro 操作编排）
  ├─ tools（hydro_*，模型可见）
  ├─ routes（客户端 API）
  ├─ CommunityService（只读轮询）
  └─ HydroProxyManager（本机 loopback 代理 + 浏览器 session 捕获）
        │ SSH 隧道
远端 Linux
  ├─ pm2: hydrooj / mongodb / caddy / hydro-sandbox / hydrojudge
  ├─ ~/.hydro/{config.json,Caddyfile,addon.json,judge.yaml}
  └─ 127.0.0.1:8888 Hydro / 27017 Mongo / 5050 sandbox
```

所有远端交互走 SSH；Hydro HTTP/Mongo 只监听远端 loopback。浏览器不直连 8888，而是访问
本机 loopback 代理 → SSH 隧道 → 远端 Caddy **:80**。

## 3. 数据与只读

默认 `$DSH_HOME/dsh-hydro/`（`config.dataDir` 可覆盖）：

```
accounts.json / keys/ / known_hosts                      SSH 主机与托管密钥
site-accounts.json / site-sessions.json               站点账号元数据 + 浏览器 session
ui-settings.json                                        全局只读（默认 true）
community.json                                          社区轮询配置与 seenDids
```

- 只读判定：`config.readonlyMode || account.readonly`；所有写工具/路由入口拒绝。
- 只读开关为绿色 ON、红色 OFF；关闭时使用插件内 React 确认框（Web/Desktop 同一实现，不依赖 window.confirm）。
- 所有危险操作确认都使用同一个插件内 `Dialog`：宿主式遮罩/浮层 token、焦点陷阱、Escape 关闭、关闭后恢复焦点、取消按钮初始聚焦；不再使用原生 confirm。
- 只读时不显示长提示、也不把写按钮置灰：点击写操作统一弹出“关闭只读并继续？”，确认后关闭只读并继续原操作。
- **不持久化任何密码**：SSH 首密码只在内存中用于安装密钥/免密 sudo；Hydro 密码只在浏览器登录时使用，插件仅保存浏览器带回的 sid session；托管私钥本地 0600，Mongo URI/输出统一脱敏。

## 4. SSH / 远端层

- `hostKeyPolicy`：`accept-new`（TOFU，默认）/ `strict` / `off`（仅测试）。
- `exec` 支持 timeout/abort/PTY；非 root 提权：`sudo -S` 优先，`su` 回退。
- 所有远端命令统一附加 nix profile PATH 前缀，避免非交互 SSH 找不到 `hydrooj/yarn/pm2`。
- 测试使用进程内 `ssh2.Server`，覆盖认证、exec、sftp、隧道、elevate、known_hosts。

## 5. Hydro 运维

- **探测**（`detect.ts`）：一条复合 shell 输出分节 JSON，含命令路径、config/addon/judge、
  pm2 jlist、安装标记、HTTP 健康、沙箱版本；解析器按分隔符容错。
- **安装**（`install.ts`）：官方脚本非交互执行；完成后校验 pm2 + HTTP + config.json。
- **状态/升级**（`status.ts`/`upgrade.ts`）：版本、插件、服务、健康、Mongo、沙箱；
  按选中包升级；Nix 包单独升级。
- **Caddy**（`caddy.ts`）：候选路径 `~/.hydro/Caddyfile` → `/etc/caddy/...`；写前备份、
  `caddy validate`、`pm2 restart caddy`；只读模式拒绝。
- **Nix**（`nix.ts`）：mirror 写入 `/etc/nix/nix.conf` 并重启 daemon；升级 profile 包。
- **插件**（`plugins.ts`）：yarn global + hydrooj addon + 重启 Hydro；安装/卸载需确认。
- **指标**（`metrics.ts`）：CPU/内存/磁盘/load；队列 `count(task)`，1 小时提交/通过，
  `record.status` 仅用于 stale 诊断；超过阈值生成 metric alert。
- **日志/排障**：pm2 日志 tail + 脱敏；已知问题扫描 + 安全修复（重启服务、装 UI 插件）。

## 6. 站点与 AI

### 6.1 独立 Hydro 站点账号

`site-accounts.json` 保存 hostId/uname/role/note；`site-sessions.json` 0600 保存浏览器捕获的 sid 与最近一次 active/expired 校验状态。
登录在**内嵌浏览器**完成（代理捕获 Set-Cookie），后端工具用 sid 调用 Hydro；session 过期时返回登录提示，不保存密码。
每个账号有独立 HTTP session 缓存；SSH 隧道重建时自动重连一次。

### 6.2 域 / 题目 / 比赛

- 域：切换默认域，内嵌 `/d/<domain>/domain/edit`；AI 修改公告/权限。
- 题目：内嵌列表/详情；`hydro_problem`（scaffold/create/edit/upload/submit/verify/publish/info）。
- 比赛：内嵌列表/详情；`hydro_contest`（create/edit/info/add_problems/announce/delete）。
- 公告：`contest/<tid>/clarification` 广播；回复讨论需 `operation=reply`。
- 题库：只支持 Hydro 官方 ZIP 题包导入。

### 6.3 内嵌浏览与上下文

`HydroProxyManager` 为每个 host 启动 `127.0.0.1:0` HTTP server，SSH 隧道指向远端
Caddy :80；浏览器在内嵌页登录后，代理捕获 sid 供后端工具使用，并转发 Cookie/WS；根路径代理避免 HTML 重写。
代理向 HTML 注入导航 shim（`target=_blank` 留在内嵌页），并记录最近路径与子页面（题目详情/编辑/数据文件，比赛详情/编辑/管理/公告/题目列表，含无 `/d/system` 前缀的系统域路径）；
`/hosts/context` 返回 kind/id/domain，供题目/比赛/域页的 AI prompt 使用。

### 6.4 社区互动

- `CommunityService` 每 N 分钟**只读**拉取讨论列表，记录新增讨论/回复数。
- 面板：配置轮询、列表、线程、手动回复（确认）、AI 回复草稿；讨论显示域/来源节点/作者并提供内嵌浏览器打开入口。
- AI 回复人设：`community.json.replyPersona` 保存自定义语气，社区面板提供预设；生成 `discussion-reply` prompt 时作为 requirements 注入。
- 回复走 `POST /d/<domain>/discuss/<did>`，必须带 `operation=reply`，并受只读保护。
- 永不自动回复；AI 只读讨论、生成草稿，用户批准后才发送。

## 7. 工具（模型可见）

| 工具 | 能力 |
| --- | --- |
| `hydro_accounts` / `hydro_site_accounts` | SSH 主机与 Hydro Web 账号管理 |
| `hydro_status` / `hydro_health` / `hydro_warnings` | 状态、健康、系统检查 |
| `hydro_install` / `hydro_upgrade` / `hydro_service` | 安装/升级/服务控制 |
| `hydro_db` / `hydro_oplog` | Mongo 只读查询、Hydro 审计日志、原生 oplog |
| `hydro_domain_config` / `hydro_system_config` / `hydro_domain_roles` | 域/系统配置、域角色权限 |
| `hydro_problem` / `hydro_contest` | 出题流水线、比赛编辑与公告 |
| `hydro_discussion` | 讨论 list/read/reply（reply 需 confirm） |
| `hydro_exec` | 任意命令，默认关闭，只读仍拒绝 |

## 8. 客户端 UI

- 注册常驻面板 `sidebar.panellist` / `main`；无宿主槽位时回退 `settings.section`。
- 菜单：**概览**；**服务器**（安装与升级 / 插件管理 / Hydro CLI / Nix / Caddy / PM2 /
  MongoDB / 智能排障）；**站点**（域管理 / 题库导入 / 题目 / 比赛 / 社区互动）；**设置**。
- 顶部：主机切换、站点账号切换、只读开关（绿开/红关）。
- 所有 AI 按钮先展开**可编辑指令框**（快捷选项 + textarea），确认后生成 prompt 并打开 Chat；
  `ctx.get('uiWorkspace').startSession` 可用时自动带入，否则回退复制。
- 图标/颜色全部使用 DSH token；i18n zh/en 字典，CJK 泄漏与未使用 key 由测试守护。
- 遵循 DSH 第三方插件 UI 规范：不直接 require Harness 的 `client-ui-primitives`（官方文档明确要求插件复制
  host 控件的 markup/CSS/行为），而是复用宿主 token、slots 与 locale；插件内部的通用
  `Card`/`Collapsible`/`ErrorLine`/`LogBlock`/`WarningList`/`PageHeading` 统一放在 `client/ui.tsx`。
- 内嵌页优先 iframe；Desktop 有官方 sidebar browser tab 时提供“在侧边栏浏览器打开”。

## 9. 安全

- 全局只读默认开启，写操作逐个确认；`confirm=true` 由路由与工具双重校验。
- `hydro_exec` 默认关闭；开启后仍受只读/输出上限约束。
- 不保存 SSH/sudo/Hydro 密码；托管私钥与 session token 文件 0600；HTTP/工具/SSE 输出脱敏。
- 内嵌代理只监听 127.0.0.1，HTTPS 终止在远端 Caddy；不额外开放远端端口。

## 10. 测试与验证

- `npx tsc -p tsconfig.json --noEmit` + `tsconfig.client.json`
- `npx vitest run`：34 个文件 / 282 passed / 2 skipped（SSH、解析、路由、工具、客户端）
- `npm run build`：host ESM + client bundle（约 210 KiB）
- `node test/client/verify-client.mjs`：21 项 bundle/路由/菜单/字典断言
- 真机验证覆盖安装、状态、域、题库、建题、判题、比赛、oplog、只读与服务；本机专用
  E2E 脚本和记录不随开源仓库发布（放在 `.local/`）。

## 11. 后续方向

- 社区定时任务接入 DSH Automation tasks（默认只生成草稿）
- 定时健康巡检、备份策略、远端并发状态汇总
- 更多比赛进行中操作（rejudge、榜单校验、balloon）
- 题解/SPJ/交互题模板与更完整的 ZIP 导入选项
