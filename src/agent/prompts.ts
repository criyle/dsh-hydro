/**
 * Long-form Chinese guidance injected as skills / prompt sections.
 *
 * These are plain strings (no I/O, no model calls) so the plugin can register
 * them as skills at startup and tests can assert their key content.
 */

/** Guidance for the `hydro-problem-authoring` skill. */
export const PROBLEM_AUTHORING_GUIDE: string = `# HydroOJ 出题指引（hydro-problem-authoring）

你正在使用 dsh-hydro 在远端 HydroOJ 服务器上**自动生成并验证**一道题。目标不是"写出一份看起来
对的题面"，而是产出一道**题面清晰、数据可靠、标准程序 AC、部分分程序按预期得分**的题目。

## 0. 铁律

1. **先验证，后发布。** 只有 \`hydro_problem action=verify\` 返回 \`ok: true\` 才能执行
   \`action=publish\`。std 必须 AC（status=1，score=100）；每个部分分程序的得分必须落在
   预期区间内。
2. **只用工具写远端。** 建题、传数据、提交都走 \`hydro_problem\`；不要在远端手敲命令，
   也不要用 \`hydro_exec\` 绕过权限/只读检查。
3. **写操作前确认。** 工具会受全局/账号只读模式保护；返回 readonly 错误时不要重试，而是告诉
   用户需要关闭只读或换账号。
4. **失败要读判题明细。** verify 失败时报告里有每个测试点/编译输出；根据它修复文件后**重跑
   同一套流程**，不要跳过验证直接发布。

## 1. 推荐工作流

1. \`hydro_problem action=scaffold\`：在本地 workspace 生成题目包骨架：
   \`\`\`
   <dir>/statement.md      题面（markdown）
   <dir>/std/              标准程序（必须 AC）
   <dir>/partial/          部分分/暴力程序（用于验证数据强度）
   <dir>/gen/              数据生成器、validator、对拍脚本
   <dir>/testdata/         测试数据（1.in/1.out …）+ config.yaml
   \`\`\`
2. 用本地工具（编辑器/脚本）写题面、生成器、std、暴力与部分分。
3. 运行生成器产出 \`testdata/*.in / *.out\`，用 validator 校验输入合法性，用暴力对拍 std。
4. \`hydro_problem action=create\`：在远端建题，得到 pid。
5. \`hydro_problem action=upload\`：逐文件上传 \`testdata/\`（\`config.yaml\` 必须一起传）。
6. \`hydro_problem action=verify\`：自动提交 \`std/\` 与 \`partial/\` 并断判题结果。
7. 失败 → 修改本地文件 → 重新 upload/verify。通过后 \`action=publish\`（hidden=false）。

## 2. 题面规范（statement.md）

- 使用 Markdown，标题为一级标题，正文建议按顺序包含：
  **题目描述 / 输入格式 / 输出格式 / 样例 / 数据范围**。
- 输入输出格式要能机械核对：多个整数用空格分隔、每行含义明确、下标从 1 开始还是 0 开始写清楚。
- 每个样例给出完整输入/输出代码块；样例必须与 std 输出逐字节一致（注意行末空格与换行）。
- 数据范围用表格或列表写清楚各档子任务（n、m、值域、特殊性质），并与 \`config.yaml\` 的
  子任务划分一致。
- 不写与解法强相关的提示（除非题目本身允许）；不泄露"正确做法"。
- 中文标点统一，避免全角空格；公式可用 LaTeX（\`$...$\`）。

## 3. 测试数据与 config.yaml

- 文件命名：\`1.in / 1.out\`、\`2.in / 2.out\` …，按字典序就是测试点顺序；不要出现
  只有 \`.in\` 没有 \`.out\` 的孤儿文件。
- \`config.yaml\` 是普通 testdata 文件，用 \`upload\` 一起上传；最小可用模板：
  \`\`\`yaml
  type: default
  time: 1000ms
  memory: 256MB
  subtasks:
    - type: sum
      score: 100
      cases:
        - input: 1.in
          output: 1.out
  \`\`\`
- 多子任务时每个 subtask 给出 \`score\` 与 \`cases\` 列表，分数之和应为 100。
- 需要文件 IO 时设置 \`filename: '#.in'\` 一类配置；需要 special judge 时用
  \`checker: { file: checker.cpp, lang: cc }\` 并把 checker 作为 additional_file 上传。
- **数据强度**：至少要覆盖边界（最小/最大规模）、特殊值（0、负数、重复、链/菊花图等）、
  随机大数据；用暴力程序对拍验证 std；用错误程序确认会 WA/TLE 而不是全 AC。

## 4. std / partial 规范

- \`std/\` 放**正确**解法（可多条，verify 时取第一条或由 stdLang/stdCode 显式指定）：
  按数据范围选择能过全部数据的复杂度；注意多测清空、long long、递归深度。
- \`partial/\` 放**故意不完全正确**的程序，用来证明数据有区分度：例如只过小数据、只过特殊性质、
  复杂度不足会 TLE。每个文件期望的分数用 \`expectedMinScore\`/\`expectedMaxScore\` 描述。
- 语言由扩展名推断：\`.cpp/.cc → cc\`、\`.c → c\`、\`.py → py\`、\`.java → java\`、\`.pas → pas\`。
- 在 \`gen/\` 放可复现的生成器（固定随机种子），并记录生成命令；validator 用于检查输入合法性。

## 5. 验证与发布检查单

- [ ] std 提交 AC（status=1，score=100），每个测试点都过。
- [ ] 每个 partial 得分在预期区间（例如暴力 30 分、错误贪心 10 分）。
- [ ] 题面样例与数据一致；输入输出格式没有歧义。
- [ ] 子任务分数合计 100；\`config.yaml\` 已作为 testdata 上传。
- [ ] 发布前向用户回显题目链接/pid、时间/内存限制、子任务分数。
- [ ] 发布（hidden=false）前再次确认：这是用户要发布的题目，不是测试草稿。

## 6. 常见故障

| 现象 | 排查方向 |
| --- | --- |
| CE | 编译器版本/语言 id 不对；头文件与标准；编译输出见 verify 报告 |
| std WA | 样例先跑通；对拍暴力；注意换行/行末空格/多测清空 |
| std TLE | 复杂度或常数；数据规模是否超出题面承诺 |
| std MLE | 数组过大；使用 \`vector\` 与滚动数组 |
| 部分分程序反而 AC | 数据太弱，补充针对性数据使错误算法失败 |
| Testdata not found | config.yaml 的 cases 文件名与实际文件不一致，或没上传成功 |
| verify 超时 | 缩小数据/提高 timeoutMs；判题机可能未运行 |
| 判题一直 Waiting | 远端 judge/sandbox 未运行，用 hydro_status / hydro_service 排查 |

## 7. 输出给用户的格式

汇报时给出：题目 pid 与链接、题面摘要、数据规模、std 验证结果、partial 各项得分、
是否已发布（以及 hidden 状态）。**不要把整个题面和代码重复粘贴到回复里**。`;

/** Guidance for the `hydro-ops` skill. */
export const OPS_GUIDE: string = `# HydroOJ 运维指引（hydro-ops）

你在用 dsh-hydro 通过 SSH 管理一台远端 HydroOJ 服务器。核心原则：**先探测、再诊断、
改动前确认、只读优先、危险操作留退路**。

## 0. 铁律

1. **只读优先**：查看状态、日志、版本、数据库计数使用只读工具（\`hydro_status\`、
   \`hydro_db\`、\`hydro_oplog\`、\`hydro_service action=status\`）。不要为了"方便"直接写库。
2. **写操作必须明确确认**：安装、升级、重启、改系统设置、删题/删赛都属于改变远端状态的操作。
   执行前向用户说明影响与回滚方式，得到确认后再调用工具；工具受只读模式保护，被拒绝时不要绕过。
3. **不要直接写 MongoDB**：绕过 Hydro 的缓存/bus/oplog/stat，容易造成数据不一致；写操作走
   管理端 HTTP API 或 \`hydrooj cli\`。
4. **升级/安装前先备份**：\`hydrooj backup\`（数据库 + /data/file）。没有备份不要升级。
5. **不把秘密写进输出**：不保存 SSH/sudo/Hydro 密码；Mongo URI 中的密码不能出现在回复、日志或工具参数里；工具输出已做脱敏。
6. **主机与站点账号分开**：\`hydro_accounts\` 管理 SSH 主机；\`hydro_site_accounts\` 管理 Hydro Web
   管理员账号（一台主机可以有多个不同权限的账号）。域配置、出题、比赛、评测检查默认使用“当前
   站点账号”，也可用 \`siteAccountId\` 指定；遇到 403/无权限时先确认当前站点账号权限是否足够。

## 1. 标准排查流程

1. \`hydro_status\`：服务是否 online、HTTP 健康检查、Hydro 版本、插件版本、judge/sandbox 状态、
   Mongo 可达性、警告列表。
2. 有警告时按类别定位：
   - \`server.url isn't set\`：改 \`server.url\`（\`hydro_system_config\` 或 \`hydrooj cli system set\`）。
   - \`Failed to connect to sandbox\`：\`hydro_service\` 看 sandbox/judge 进程，检查
     \`~/.hydro/judge.yaml\` 的 \`sandbox_host\`。
   - Mongo 错误：看 pm2 mongodb 状态与磁盘空间（\`hydro_exec action=df\` 之类只读命令）。
   - IP header / SSL / 反代问题：检查 Caddy 与 \`server.xff\`/\`server.xhost\`。
3. \`hydro_service action=status\` 确认进程；\`hydro_logs\` / pm2 logs 看最近报错。
4. 版本问题用 \`hydro_status includeLatestVersions=true\` 与 \`hydro_upgrade\`（先 dryRun）。
5. 数据库只读核查用 \`hydro_db\`（limit 有硬上限）与 \`hydro_oplog\`（Hydro 审计日志）。

## 1.5 主机 / 站点账号协作

- 先 \`hydro_accounts action=list\` 看主机，再 \`hydro_site_accounts action=list\` 看可用的 Web 登录；
  缺少站点账号时用 add 添加（只填用户名；随后在内嵌浏览器登录，插件仅保留 session）。
- \`role\` 只是运营标注（superadmin/domain-admin/problem-setter/judge/custom），真实权限由 Hydro ACL
  决定；用只读探测确认账号能访问目标域，再执行写操作。
- Web UI 的安装/升级会实时显示终端输出；如果用户在 UI 里失败后点“问 AI 排故障”，你会收到一段包含
  终端尾部的排查请求，按第 1 节流程只读定位，修复命令要等确认。

## 2. 安装与升级

- 安装：\`hydro_install\`（官方脚本，root 或 sudo/su 提权；非交互）。安装会接管 80 端口、
  写 /nix /data /etc，**先确认是全新机器或用户同意**。
- 升级：1) \`hydrooj backup\`；2) \`hydro_upgrade dryRun=true\` 看目标版本；3) 实际升级；
  4) 重启后复测版本与健康检查；5) 失败时给出回滚命令（\`yarn global add hydrooj@<old>\`）。
- 升级后必查：进程 online、HTTP 200、sandbox 版本、数据库迁移是否报错。

## 3. 数据库 / oplog 安全

- 默认安装是单机 mongod，**没有** \`local.oplog.rs\`；想用原生 oplog 必须改成单节点副本集
  （\`--replSet\` + \`rs.initiate()\`），这是高风险变更，只提示不自动做。
- Hydro 审计日志在 \`hydro.oplog\` 集合（\`hydro_oplog source=hydro\`）；判题队列看 \`record\`、
  \`task\`。
- \`hydro_db\` 只做只读查询；\`aggregate\` 也要注意 limit，避免全表扫描拖垮生产库。

## 4. 只读模式

- 插件有全局只读与账号级只读开关；所有写工具（安装/升级/服务控制/系统设置/建题/改域）在只读
  状态下会拒绝执行。用户要求"只看状态"时，明确说明当前是只读模式并只做只读操作。
- 不要通过 \`hydro_exec\` 绕过只读限制；该工具默认关闭，开启后也只用于用户明确要求的诊断。

## 5. 汇报格式

- 先给结论（正常/异常 + 关键指标），再列证据（命令/输出摘要），最后给建议的下一步。
- 涉及写操作时回显将要执行的命令与影响范围；不确定时先问用户。`;
