/**
 * 读侧视图：研究员进度、委员待办、管理员全量追溯。
 * 只读不写；成果 due/overdue 等时效状态在查询时按当前时间即时派生。
 */
import type {
  Actor,
  Application,
  ApplicationVersion,
  ResultState,
  ReviewPath,
  ReviewStage,
  ServiceState,
} from "./types.js";
import { RULES } from "./rules.js";
import { forbidden, notFound } from "./errors.js";
import { zoneAvailability } from "./inventory.js";

export function effectiveResultState(
  result: { dueAt: string; state: ResultState } | undefined,
  now: Date,
): ResultState | undefined {
  if (!result) return undefined;
  if (result.state === "received") return "received";
  const due = new Date(result.dueAt);
  if (now.getTime() > due.getTime()) return "overdue";
  if (due.getTime() - now.getTime() <= RULES.resultDueSoonDays * 24 * 60 * 60 * 1000) return "due";
  return "not_due";
}

export interface StageProgress {
  name: string;
  poolSize: number;
  votes: number;
  outcome?: ReviewStage["outcome"];
  current: boolean;
}

export function pathProgress(path: ReviewPath | undefined): StageProgress[] {
  if (!path) return [];
  const firstUndecided = path.stages.findIndex((stage) => stage.outcome === undefined);
  return path.stages.map((stage, index) => ({
    name: stage.name,
    poolSize: stage.pool.length,
    votes: stage.votes.length,
    outcome: stage.outcome,
    current: index === firstUndecided && path.status === "active",
  }));
}

export interface ApplicationView {
  application: Application;
  reviewPath?: ReviewPath | undefined;
  progress: StageProgress[];
  openSupplements: Application["supplements"];
  effectiveResultState?: ResultState | undefined;
  resultDueAt?: string | undefined;
}

function applicationView(state: ServiceState, application: Application, now: Date): ApplicationView {
  const version = application.versions.find((item) => item.versionNo === application.currentVersionNo)!;
  return {
    application,
    reviewPath: version.reviewPath,
    progress: pathProgress(version.reviewPath),
    openSupplements: application.supplements.filter((item) => item.status === "open"),
    effectiveResultState: effectiveResultState(application.result, now),
    resultDueAt: application.result?.dueAt,
  };
}

export class QueryService {
  constructor(
    private readonly getState: () => ServiceState,
    private readonly now: () => Date,
  ) {}

  /** 研究员视角：本人全部申请的进度与补件项。 */
  researcherDashboard(actor: Actor): { applications: ApplicationView[] } {
    if (!actor.roles.includes("researcher")) forbidden("需要 researcher 角色");
    const state = this.getState();
    const applications = Object.values(state.applications)
      .filter((item) => item.applicantUserId === actor.userId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((item) => applicationView(state, item, this.now()));
    return { applications };
  }

  /** 单个申请详情：申请人、参与委员、管理员可见；回避委员不可见表决细节。 */
  applicationDetail(actor: Actor, requestId: string): ApplicationView {
    const state = this.getState();
    const application = state.applications[requestId];
    if (!application) notFound(`申请 ${requestId} 不存在`);
    const isOwner = application.applicantUserId === actor.userId;
    const isStaff = actor.roles.includes("reviewer") || actor.roles.includes("admin");
    if (!isOwner && !isStaff) forbidden("无权查看该申请");
    return applicationView(state, application, this.now());
  }

  /** 委员视角：当前轮到自己、且无回避关系的在审申请。 */
  reviewerQueue(actor: Actor): { queue: Array<ApplicationView & { stage: string; recused: boolean }> } {
    if (!actor.roles.includes("reviewer")) forbidden("需要 reviewer 角色");
    const state = this.getState();
    const reviewer = state.reviewers[actor.userId];
    const queue = Object.values(state.applications)
      .filter((item) => ["submitted", "reviewing"].includes(item.state))
      .flatMap((item) => {
        const view = applicationView(state, item, this.now());
        const path = view.reviewPath;
        if (!path) return [];
        const stage = path.stages.find((entry) => entry.outcome === undefined);
        if (!stage) return [];
        // 未登记名册的账号没有待办，也不暴露申请存在。
        if (!reviewer) return [];
        const recused =
          reviewer.conflictUserIds.includes(item.applicantUserId) ||
          (reviewer.orgId !== undefined && reviewer.orgId === item.applicantOrgId) ||
          reviewer.conflictOrgIds.includes(item.applicantOrgId);
        if (recused) return [{ ...view, stage: stage.name, recused: true }];
        if (!stage.pool.includes(actor.userId)) return [];
        return [{ ...view, stage: stage.name, recused: false }];
      })
      .sort((a, b) => a.application.id.localeCompare(b.application.id));
    return { queue };
  }

  /**
   * 管理员视角：从每个分区的剩余质量出发，串联全部决定（含历史版本）、
   * 切割/偏差记录、预留、成果到期状态与每次采用的规则版本。
   */
  adminTrace(specimenId?: string) {
    const state = this.getState();
    const now = this.now();
    const specimens = Object.values(state.specimens)
      .filter((specimen) => specimenId === undefined || specimen.id === specimenId)
      .map((specimen) => ({
        specimen: { id: specimen.id, code: specimen.code, name: specimen.name },
        zones: specimen.zones.map((zone) => {
          const availability = zoneAvailability(state, specimen.id, zone.id);
          const relatedHolds = Object.values(state.holds).filter((hold) => hold.zoneId === zone.id);
          const cuttings = state.cuttings
            .filter((cutting) => cutting.zoneId === zone.id)
            .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
          return {
            zoneId: zone.id,
            ...stripZone(availability),
            holds: relatedHolds,
            cuttings: cuttings.map((cutting) => ({
              id: cutting.id,
              requestId: cutting.requestId,
              sampledAt: cutting.sampledAt,
              recordedAt: cutting.recordedAt,
              recordedBy: cutting.recordedBy,
              approvedMassMg: cutting.approvedMassMg,
              actualMassMg: cutting.actualMassMg,
              approvedMethod: cutting.approvedMethod,
              actualMethod: cutting.actualMethod,
              variance: cutting.variance,
            })),
          };
        }),
      }));

    const applications = Object.values(state.applications)
      .filter((item) => specimenId === undefined || item.specimenId === specimenId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((item) => this.traceApplication(item, now));

    return { generatedAt: now.toISOString(), ruleVersion: RULES.ruleVersion, specimens, applications };
  }

  private traceApplication(application: Application, now: Date) {
    return {
      requestId: application.id,
      applicantUserId: application.applicantUserId,
      applicantOrgId: application.applicantOrgId,
      specimenId: application.specimenId,
      state: application.state,
      currentVersionNo: application.currentVersionNo,
      result: application.result
        ? { ...application.result, effectiveState: effectiveResultState(application.result, now) }
        : undefined,
      versions: application.versions.map((version): TracedVersion => ({
        versionNo: version.versionNo,
        versionId: version.id,
        submittedAt: version.submittedAt,
        decision: version.decision,
        keyParams: {
          purpose: version.purpose,
          zoneId: version.zoneId,
          locationNotes: version.locationNotes,
          estimatedMassMg: version.estimatedMassMg,
          method: version.method,
          deliverables: version.deliverables,
          resultReturnBy: version.resultReturnBy,
          confidentialityMonths: version.confidentialityMonths,
        },
        ruleVersion: version.reviewPath?.ruleVersion ?? version.decisionRecord?.ruleVersion,
        pathStages: version.decisionRecord?.pathSnapshot ?? version.reviewPath?.stages,
        decisionRecord: version.decisionRecord,
      })),
      supplements: application.supplements,
    };
  }
}

type TracedVersion = {
  versionNo: number;
  versionId: string;
  submittedAt?: string | undefined;
  decision: ApplicationVersion["decision"];
  keyParams: Omit<
    ApplicationVersion,
    "id" | "versionNo" | "createdAt" | "submittedAt" | "decision" | "reviewPath" | "decisionRecord"
  >;
  ruleVersion?: string | undefined;
  pathStages?: ReviewStage[] | undefined;
  decisionRecord?: ApplicationVersion["decisionRecord"];
};

function stripZone(availability: ReturnType<typeof zoneAvailability>) {
  const { specimenId: _s, zoneId: _z, ...rest } = availability;
  void _s;
  void _z;
  return rest;
}
