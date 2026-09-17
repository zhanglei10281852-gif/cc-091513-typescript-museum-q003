/**
 * 审批规则集。所有规则带语义化版本号：路径生成、投票推进、偏差判定
 * 都把当时的 ruleVersion 落档，管理员可追溯“每次采用的规则版本”。
 *
 * 修改任何阈值或判定逻辑都必须提升版本号。
 */
export const RULES = Object.freeze({
  ruleVersion: "1.0.0",
  /** 预计质量超过该阈值（mg）升级为委员会评审。 */
  committeeMassThresholdMg: 500,
  /** 取样后区域实物余量若低于该安全库存（mg），追加主任签批。 */
  safetyReserveMg: 200,
  /** 委员会有效决议人数。 */
  committeeQuorum: 3,
  /** 送审后审批 SLA（天），超时自动拒绝并释放预留。 */
  reviewSlaDays: 14,
  /** 批准有效期（天），逾期未取样释放预留。 */
  approvalValidDays: 90,
  /** 取样质量偏差容忍度（百分比）。 */
  massTolerancePercent: 10,
  /** 成果到期前多少天进入 due 提醒。 */
  resultDueSoonDays: 7,
});

export type Rules = typeof RULES;
