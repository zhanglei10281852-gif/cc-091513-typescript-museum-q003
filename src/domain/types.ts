/**
 * 科研取样决策服务的领域类型定义。
 *
 * 设计要点：
 * - 申请参数在送审后冻结为不可变的“版本”，关键参数改动产生新版本；
 * - 额度以“预留(Hold)”表达，只在拒绝、超时、撤回时释放；
 * - 审批结论一旦作出不可修改，实际取样偏差只追加记录并重算实物余量。
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

export type UserRole = "researcher" | "reviewer" | "admin";

export interface Actor {
  userId: string;
  roles: UserRole[];
}

/** 标本分区。未加固区往往仅存一份，是并发预留冲突的主要来源。 */
export interface SpecimenZone {
  id: string;
  name: string;
  /** 是否已加固；未加固区域的取样自动升级为委员会评审。 */
  reinforced: boolean;
  /** 该区域建档时的可用质量（mg），实物余量据此与切割记录重算。 */
  initialMassMg: number;
}

export interface Specimen {
  id: string;
  code: string;
  name: string;
  zones: SpecimenZone[];
  createdAt: string;
}

/** 委员（主任是 isDirector 的委员）。orgId 与冲突名单共同决定回避。 */
export interface Reviewer {
  id: string;
  name: string;
  orgId?: string | undefined;
  isDirector: boolean;
  conflictUserIds: string[];
  conflictOrgIds: string[];
}

/** 申请人可修改的申请参数（关键参数，送审后任何一项变化都会产生新版本）。 */
export interface ApplicationDraft {
  purpose: string;
  /** 取样位置：标本分区标识 + 文字说明。 */
  zoneId: string;
  locationNotes: string;
  /** 预计取样质量（mg）。 */
  estimatedMassMg: number;
  /** 检测方法。 */
  method: SamplingMethod;
  /** 成果返还承诺：返还物清单与承诺返还日期（ISO）。 */
  deliverables: string[];
  resultReturnBy: string;
  /** 保密期限（月）。 */
  confidentialityMonths: number;
}

export type VersionDecision =
  | "pending"
  | "approved"
  | "rejected"
  | "withdrawn"
  | "superseded"
  | "timeout";

export interface Vote {
  reviewerId: string;
  value: "approve" | "reject" | "request_changes";
  comment?: string | undefined;
  round: number;
  at: string;
  ruleVersion: string;
}

export type StageName = "sole_review" | "committee_review" | "director_signoff";

export interface ReviewStage {
  name: StageName;
  /** 经回避过滤后可参与本阶段的委员 id 池。 */
  pool: string[];
  votes: Vote[];
  outcome?: "approved" | "rejected";
  decidedBy?: string[];
}

export interface ReviewPath {
  ruleVersion: string;
  /** active：可投票；blocked_recusal：回避后人数不足，需管理员增补委员后重建。 */
  status: "active" | "blocked_recusal" | "completed";
  stages: ReviewStage[];
  generatedAt: string;
  /** 等待补件时为当前阶段序号，补件提交后该轮投票重置。 */
  awaitingSupplementAtStage?: number | undefined;
  round: number;
}

export interface DecisionRecord {
  kind: "approved" | "rejected";
  /** 批准编号；拒绝时为空。 */
  approvalNo?: string;
  at: string;
  by: string[];
  ruleVersion: string;
  /** 拒绝/超时原因（如 review_timeout、committee_vote）。 */
  reason?: string;
  /** 批准时冻结的批准量（mg），事后不可修改。 */
  approvedMassMg?: number;
  /** 批准有效期截止时间；逾期未取样释放预留，批准结论本身保留。 */
  approvalExpiresAt?: string;
  /** 保密截止时间。 */
  confidentialityUntil?: string;
  /** 生成路径时的阶段快照（含委员池），供追溯。 */
  pathSnapshot: ReviewStage[];
}

export interface ApplicationVersion extends ApplicationDraft {
  id: string;
  versionNo: number;
  createdAt: string;
  submittedAt?: string;
  decision: VersionDecision;
  reviewPath?: ReviewPath;
  decisionRecord?: DecisionRecord;
}

export type SupplementStatus = "open" | "submitted" | "accepted";

export interface SupplementItem {
  id: string;
  versionNo: number;
  field: string;
  note: string;
  requestedBy: string;
  status: SupplementStatus;
  response?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface ResultFulfilment {
  dueAt: string;
  state: ResultState;
  deliverables: string[];
  receivedAt?: string | undefined;
  receivedNote?: string | undefined;
}

export interface Application {
  id: string;
  applicantUserId: string;
  applicantOrgId: string;
  specimenId: string;
  state: RequestState;
  currentVersionNo: number;
  versions: ApplicationVersion[];
  supplements: SupplementItem[];
  result?: ResultFulfilment;
  createdAt: string;
  updatedAt: string;
}

export type HoldStatus = "held" | "released" | "consumed";

export interface MaterialHold {
  id: string;
  requestId: string;
  versionId: string;
  specimenId: string;
  zoneId: string;
  /** 预占质量（mg），等于提交版本的预计质量。 */
  massMg: number;
  status: HoldStatus;
  createdAt: string;
  releasedAt?: string;
  /** released: rejected | withdrawn | timeout | superseded | cutting_settlement | approval_expired */
  releaseReason?: string;
  consumedAt?: string;
  /** 切割结算时实际占用质量，可能与预占不同。 */
  settledMassMg?: number;
}

export interface VarianceRecord {
  ruleVersion: string;
  approvedMassMg: number;
  actualMassMg: number;
  /** 实际 - 批准（mg），正为超取，负为少取。 */
  deltaMg: number;
  /** 偏差百分比，相对批准量。 */
  percent: number;
  withinTolerance: boolean;
  methodMatchesApproved: boolean;
  note?: string | undefined;
}

export interface CuttingRecord {
  id: string;
  requestId: string;
  versionId: string;
  specimenId: string;
  zoneId: string;
  approvedMassMg: number;
  actualMassMg: number;
  approvedMethod: SamplingMethod;
  actualMethod: SamplingMethod;
  sampledAt: string;
  recordedAt: string;
  recordedBy: string;
  variance: VarianceRecord;
}

/** 服务完整状态，可整体快照持久化。 */
export interface ServiceState {
  specimens: Record<string, Specimen>;
  reviewers: Record<string, Reviewer>;
  applications: Record<string, Application>;
  holds: Record<string, MaterialHold>;
  cuttings: CuttingRecord[];
  /** 申请编号 / 批准编号的单调序列。 */
  counters: { application: number; approval: number };
}
