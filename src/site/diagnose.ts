/**
 * One-click "ask AI to troubleshoot" prompt for a failed/slow host task.
 *
 * Built on the host side so the client never has to know tool names or the
 * operational safety rules; the browser only forwards the task kind, the error
 * message and the terminal tail.
 */
import { OPS_GUIDE } from '../agent/prompts.js'

export interface DiagnoseInput {
  hostLabel: string
  address: string
  username: string
  kind: 'install' | 'upgrade' | 'issues'
  /** Final failure message, when there is one. */
  message?: string
  /** Terminal output tail (bounded by the caller). */
  output: string
}

/**
 * Build the troubleshooting prompt.
 * @param input - host identity, task kind, failure message and output tail.
 * @returns a Chinese prompt for a new agent conversation.
 */
export function buildDiagnosePrompt(input: DiagnoseInput): string {
  const tail = input.output.trim().length === 0 ? '（终端没有输出）' : input.output.trim().slice(-4000)
  const action = input.kind === 'install' ? '安装 Hydro' : input.kind === 'upgrade' ? '升级 Hydro' : '智能排障检查'
  const failure = input.message?.trim() !== undefined && input.message.trim() !== ''
    ? input.message.trim()
    : '（任务没有明确错误信息，可能是超时、网络或权限问题）'
  return [
    `请帮我排查一次失败的远程操作。`,
    `主机：${input.hostLabel}（${input.username}@${input.address}）`,
    `操作：${action}`,
    `错误信息：${failure}`,
    '',
    '终端最后一段输出：',
    '```text',
    tail,
    '```',
    '',
    OPS_GUIDE,
    '',
    '排查要求：',
    '1. 先用只读工具收集信息：hydro_status（服务/健康/版本/警告）、hydro_service target=hydro action=status、必要时 hydro_db/hydro_oplog 查看最近日志；',
    '2. 结合输出判断根因（网络/DNS、磁盘空间、权限/sudo、端口占用、nix/pnpm 源、MongoDB、systemd/pm2 状态、容器限制等）；',
    '3. 给出按可能性排序的根因假设和可执行的修复步骤；任何会修改远端的命令都要先说明影响并等我确认，不要擅自重装或升级；',
    '4. 如果确认需要重试安装/升级，请在回复里给出明确的确认命令或按钮操作提示；',
    '5. 最后用简短清单总结：根因 → 修复步骤 → 如何验证。',
  ].join('\n')
}
