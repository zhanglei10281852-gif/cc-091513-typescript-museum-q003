/**
 * 版本化审批规则。
 *
 * 每个申请版本在送审时锁定当时的规则版本；规则升级只影响此后送审的版本，
 * 在途版本继续按锁定版本执行，管理员可追溯每次决定采用的规则版本。
 */
import type { SamplingMethod } from "./types.js";

export interface RuleSet {
  version: string;
  /** 委员会评审截止时长（小时），超时释放额度。 */
  reviewTimeoutHours: number;
  /** 单次申请占可用余量比例上限。 */
  maxQuotaRatioOfAvailable: number;
  /** 高风险（消耗未加固区）申请占可用余量比例上限。 */
  maxQuotaRatioUnreinforced: number;
  /** 触发委员会评审的质量阈值（mg）。 */
  committeeMassThresholdMg: number;
  /** 实际取样相对批准量允许的偏差（绝对值），超过则记为超差。 */
  deviationToleranceRatio: number;
  /** 各检测方法在未加固区的最小破坏性等级（1-4）。 */
  methodDestructiveness: Record<SamplingMethod, number>;
  /** 未加固区允许的最大破坏性等级；超过则系统驳回。 */
  maxDestructivenessUnreinforced: number;
  /** 委员人数；人数不足时申请挂起 blocked，不预占额度。 */
  committeeSize: number;
}

export const RULES_2026_09_V1: RuleSet = Object.freeze({
  version: "rules-2026-09-v1",
  reviewTimeoutHours: 72,
  maxQuotaRatioOfAvailable: 0.5,
  maxQuotaRatioUnreinforced: 0.25,
  committeeMassThresholdMg: 500,
  deviationToleranceRatio: 0.1,
  methodDestructiveness: Object.freeze({
    surface_swab: 1,
    powder: 2,
    micro_drill: 3,
    section: 4,
  }),
  maxDestructivenessUnreinforced: 2,
  committeeSize: 3,
});

/** 规则演进时新增条目；旧条目保留不动，已锁定版本仍可解析。 */
export const RULE_HISTORY: readonly RuleSet[] = Object.freeze([RULES_2026_09_V1]);

const RULE_INDEX = new Map<string, RuleSet>(RULE_HISTORY.map((r) => [r.version, r]));

export function getRule(version: string): RuleSet {
  const rule = RULE_INDEX.get(version);
  if (!rule) throw new Error(`unknown_rule_version: ${version}`);
  return rule;
}

export function latestRuleVersion(): string {
  return RULE_HISTORY[RULE_HISTORY.length - 1]!.version;
}

/** 路由规则：决定评审模式。 */
export function resolveReviewMode(
  plannedMassMg: number,
  unreinforced: boolean,
): "single" | "committee_unanimous" | "committee_majority" {
  if (unreinforced) return "committee_unanimous";
  if (plannedMassMg >= RULES_2026_09_V1.committeeMassThresholdMg) {
    return "committee_majority";
  }
  return "single";
}
