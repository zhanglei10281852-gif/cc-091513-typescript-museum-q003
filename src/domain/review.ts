/**
 * 委员回避与审批路径生成。
 *
 * 回避关系（任一命中即须回避）：
 *  1. 委员 conflictUserIds 含申请人；
 *  2. 委员 conflictOrgIds 含申请单位，或委员本人与申请人同单位；
 * 路径按规则版本生成：普通件单人初审；未加固区 / 大质量件上委员会；
 * 取样后将跌破安全库存的，追加主任签批。任一阶段回避后人数不足，
 * 路径标记 blocked_recusal，须管理员增补委员后重建。
 */
import type {
  Application,
  ReviewPath,
  ReviewStage,
  Reviewer,
  ServiceState,
} from "./types.js";
import { RULES } from "./rules.js";
import { zoneAvailability } from "./inventory.js";
import { iso } from "./clock.js";

export function conflictsWith(reviewer: Reviewer, applicantUserId: string, applicantOrgId: string): boolean {
  if (reviewer.conflictUserIds.includes(applicantUserId)) return true;
  if (reviewer.orgId !== undefined && reviewer.orgId === applicantOrgId) return true;
  if (reviewer.conflictOrgIds.includes(applicantOrgId)) return true;
  return false;
}

/**
 * 依据当前状态（调用方须保证预占已写入）生成评审路径。
 * 不写入任何业务数据，只返回路径对象；保留旧投票由服务层处理。
 */
export function generatePath(
  state: ServiceState,
  application: Pick<Application, "applicantUserId" | "applicantOrgId">,
  specimenId: string,
  zoneId: string,
  estimatedMassMg: number,
  reinforced: boolean,
  now: Date,
): ReviewPath {
  const eligible = Object.values(state.reviewers)
    .filter((reviewer) => !conflictsWith(reviewer, application.applicantUserId, application.applicantOrgId))
    .sort((a, b) => a.id.localeCompare(b.id));
  // 主任保留给签批阶段，不进入委员会表决池，避免同一人两次表决。
  const committeeEligible = eligible.filter((reviewer) => !reviewer.isDirector);

  const availability = zoneAvailability(state, specimenId, zoneId);
  const projectedRemainder = availability.availableMassMg - estimatedMassMg;
  const committeeNeeded =
    !reinforced || estimatedMassMg > RULES.committeeMassThresholdMg;
  const directorNeeded = projectedRemainder < RULES.safetyReserveMg;

  const stages: ReviewStage[] = [];
  let blocked = false;

  if (committeeNeeded) {
    if (committeeEligible.length < RULES.committeeQuorum) blocked = true;
    stages.push({
      name: "committee_review",
      pool: committeeEligible.map((reviewer) => reviewer.id),
      votes: [],
    });
  } else {
    // 主任保留给签批环节；普通委员优先独任初审。
    const sole = eligible.find((reviewer) => !reviewer.isDirector) ?? eligible[0];
    if (!sole) blocked = true;
    stages.push({
      name: "sole_review",
      pool: sole ? [sole.id] : [],
      votes: [],
    });
  }

  if (directorNeeded) {
    const directors = eligible.filter((reviewer) => reviewer.isDirector);
    if (directors.length === 0) blocked = true;
    stages.push({
      name: "director_signoff",
      pool: directors.map((reviewer) => reviewer.id),
      votes: [],
    });
  }

  return {
    ruleVersion: RULES.ruleVersion,
    status: blocked ? "blocked_recusal" : "active",
    stages,
    generatedAt: iso(now),
    round: 1,
  };
}

/** 路径被阻塞的人类可读原因（取各空池阶段的说明）。 */
export function blockReason(path: ReviewPath): string | undefined {
  if (path.status !== "blocked_recusal") return undefined;
  const committee = path.stages.find((stage) => stage.name === "committee_review" && stage.pool.length < RULES.committeeQuorum);
  if (committee) {
    return `回避后仅剩 ${committee.pool.length} 名委员，不足法定人数 ${RULES.committeeQuorum}`;
  }
  const sole = path.stages.find((stage) => stage.name === "sole_review" && stage.pool.length === 0);
  if (sole) return "回避后没有可担任独任初审的委员";
  const director = path.stages.find((stage) => stage.name === "director_signoff" && stage.pool.length === 0);
  if (director) return "回避后没有可签批的主任委员";
  return "评审路径因回避人数不足被阻塞";
}
