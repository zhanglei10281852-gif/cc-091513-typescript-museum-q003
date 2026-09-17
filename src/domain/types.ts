/**
 * 领域模型：标本、申请人/委员、取样申请（多版本）、审批步骤、
 * 切割记录、偏差记录、成果承诺与事件日志。
 *
 * 所有标识均为稳定字符串 ID；质量单位统一为毫克(mg)，允许小数。
 */

export const REQUEST_STATES = [
  "draft",
  "submitted",
  "reviewing",
  "approved",
  "rejected",
  "withdrawn",
] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

export const SAMPLING_METHODS = [
  "surface_swab",
  "micro_drill",
  "section",
  "powder",
] as const;
export type SamplingMethod = (typeof SAMPLING_METHODS)[number];

export const RESULT_STATES = ["not_due", "due", "received", "overdue"] as const;
export type ResultState = (typeof RESULT_STATES)[number];

export type UserRole = "applicant" | "reviewer" | "director" | "admin";

export interface User {
  id: string;
  name: string;
  role: UserRole;
  /** 所属高校/机构 ID；委员与申请人同机构时自动回避。 */
  institutionId: string | null;
}

/** 标本取样区：未加固区被消耗属于不可逆的高风险操作。 */
export interface SpecimenZone {
  id: string;
  name: string;
  reinforced: boolean;
  initialMassMg: number;
}

export interface Specimen {
  id: string;
  name: string;
  initialMassMg: number;
  zones: SpecimenZone[];
  createdAt: string;
}

/** 显式委员回避关系（除同机构自动回避外）。 */
export interface Recusal {
  id: string;
  reviewerId: string;
  applicantId: string | null;
  institutionId: string | null;
  reason: string;
  createdAt: string;
}

export interface ResultPromise {
  /** 承诺返还的成果形式（原始数据/切片/研究报告等）。 */
  deliverable: string;
  /** 实际取样完成后多少天内返还。 */
  dueDays: number;
}

/** 送审后关键参数的每次改动都会产生新版本，旧版本不可变。 */
export interface ApplicationVersion {
  versionNo: number;
  /** 该版本送审时锁定的规则版本，后续规则升级不影响在途版本。 */
  ruleVersion: string;
  purpose: string;
  zoneId: string;
  plannedMassMg: number;
  method: SamplingMethod;
  resultPromise: ResultPromise;
  confidentialityMonths: number;
  /** 委员会评审模式：单人、三人全票、三人多数。 */
  reviewMode: "single" | "committee_unanimous" | "committee_majority";
  createdAt: string;
  superseded: boolean;
}

export type StepStatus =
  | "pending"
  | "waiting_supplement"
  | "approved"
  | "rejected"
  | "closed";

export interface ReviewStep {
  id: string;
  versionNo: number;
  stepNo: number;
  kind: "reviewer" | "director";
  assigneeId: string;
  status: StepStatus;
  ruleVersion: string;
  openedAt: string;
  decidedAt: string | null;
}

export interface DecisionRecord {
  id: string;
  versionNo: number;
  /** 系统驳回决定不关联具体步骤。 */
  stepNo: number | null;
  actorId: string;
  actorKind: "reviewer" | "director" | "system";
  vote: "approve" | "reject";
  comment: string;
  /** 本决定实际采用的规则版本。 */
  ruleVersion: string;
  reason: string | null;
  at: string;
}

export interface SupplementRequest {
  id: string;
  applicationId: string;
  stepId: string;
  versionNo: number;
  requestedBy: string;
  items: string[];
  reason: string;
  status: "requested" | "submitted" | "accepted";
  createdAt: string;
  submittedAt: string | null;
  response: string;
}

/** 实际切割/取样记录；实际量与批准量的任何偏差另记 DeviationRecord。 */
export interface CuttingRecord {
  id: string;
  applicationId: string;
  versionNo: number;
  specimenId: string;
  zoneId: string;
  method: SamplingMethod;
  plannedMassMg: number;
  actualMassMg: number;
  sampledAt: string;
  ruleVersion: string;
  deviationId: string | null;
}

export interface DeviationRecord {
  id: string;
  cuttingRecordId: string;
  applicationId: string;
  plannedMassMg: number;
  actualMassMg: number;
  deltaMg: number;
  ratio: number;
  withinTolerance: boolean;
  note: string;
  recordedAt: string;
}

export interface ResultCommitment {
  deliverable: string;
  dueDays: number;
  promisedAt: string;
  /** 切割完成后确定；未切割时为 null，状态恒为 not_due。 */
  dueAt: string | null;
  receivedAt: string | null;
  state: ResultState;
}

export interface ApplicationEvent {
  seq: number;
  at: string;
  type: string;
  actorId: string;
  detail: unknown;
}

export interface Application {
  id: string;
  applicantId: string;
  institutionId: string | null;
  specimenId: string;
  state: RequestState;
  currentVersionNo: number;
  versions: ApplicationVersion[];
  steps: ReviewStep[];
  decisions: DecisionRecord[];
  supplements: SupplementRequest[];
  cuttings: CuttingRecord[];
  deviations: DeviationRecord[];
  result: ResultCommitment | null;
  /** 无法形成法定人数等非硬性阻塞原因。 */
  blockedReason: string | null;
  reviewDeadline: string | null;
  submittedAt: string | null;
  finalizedAt: string | null;
  terminalReason: string | null;
  sampledAt: string | null;
  events: ApplicationEvent[];
}

export interface DataState {
  seq: number;
  currentRuleVersion: string;
  users: Record<string, User>;
  specimens: Record<string, Specimen>;
  recusals: Recusal[];
  applications: Record<string, Application>;
}
