/**
 * Model-facing skills registered by the plugin entry point.
 *
 * A skill is durable guidance the model can load on demand (no prompt cost
 * until loaded). Both skills are Chinese because the plugin targets Chinese
 * HydroOJ operators.
 */
import { OPS_GUIDE, PROBLEM_AUTHORING_GUIDE } from '../agent/prompts.js'

/** One registrable skill. */
export interface SkillContent {
  /** Unique skill name (kebab-case). */
  name: string
  /** One-line description shown in the skill catalog. */
  description: string
  /** Full guidance body (markdown). */
  body: string
  /** Whether the model may load this skill itself. */
  modelInvocable: boolean
  /** Whether the user may trigger this skill explicitly. */
  userInvocable: boolean
}

/** Skill steering the automatic problem-authoring workflow. */
export const problemAuthoringSkill: SkillContent = {
  name: 'hydro-problem-authoring',
  description: '在 HydroOJ 上自动出题：题面、测试数据、std、部分分程序与验证/发布流程',
  body: PROBLEM_AUTHORING_GUIDE,
  modelInvocable: true,
  userInvocable: true,
}

/** Skill steering Hydro install/upgrade/status/db operations. */
export const hydroOpsSkill: SkillContent = {
  name: 'hydro-ops',
  description: 'HydroOJ 远端运维：状态排查、安装升级、服务控制、数据库只读核查与只读模式',
  body: OPS_GUIDE,
  modelInvocable: true,
  userInvocable: true,
}

/** Every skill this plugin registers. */
