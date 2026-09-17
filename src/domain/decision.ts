/**
 * 取样决策服务：申请生命周期、额度预留、回避评审、切割偏差与成果追踪。
 *
 * 不变量：
 *  - 所有写操作在 DomainStore 互斥区内完成，读余量→判定→落预留原子化；
 *  - 送审后关键参数不可原地修改，改动产生新版本并释放旧版本预留；
 *  - 预留只在拒绝、超时、撤回（含被新版本替代）时释放；批准后由切割结算；
 *  - 已作出的批准/拒绝结论不可修改，取样偏差只追加切割记录、重算实物余量。
 */
import type {
  Actor,
  Application,
  ApplicationDraft,
  ApplicationVersion,
  CuttingRecord,
  MaterialHold,
  ReviewPath,
  ReviewStage,
  Reviewer,
  ResultState,
  SamplingMethod,
  ServiceState,
  Specimen,
  SpecimenZone,
  SupplementItem,
  Vote,
} from "./types.js";
import { SAMPLING_METHODS } from "./types.js";
import type { DomainStore } from "./store.js";
import type { Clock } from "./clock.js";
import { iso, newId, plusDays, plusMonths } from "./clock.js";
import { RULES } from "./rules.js";
import { badRequest, conflict, forbidden, notFound } from "./errors.js";
import {
  getSpecimen,
  getZone,
  reservationBlocker,
  zoneAvailability,
} from "./inventory.js";
import { blockReason, conflictsWith, generatePath } from "./review.js";

function requireRole(actor: Actor, role: Actor["roles"][number]): void {
  if (!actor.roles.includes(role)) forbidden(`需要 ${role} 角色`);
}

function getApplication(state: ServiceState, id: string): Application {
  const application = state.applications[id];
  if (!application) notFound(`申请 ${id} 不存在`);
  return application;
}

function currentVersion(application: Application): ApplicationVersion {
  const version = application.versions.find(
    (item) => item.versionNo === application.currentVersionNo,
  );
  if (!version) notFound(`申请 ${application.id} 的当前版本缺失`);
  return version;
}

function validateDraft(state: ServiceState, specimenId: string, draft: ApplicationDraft): void {
  getSpecimen(state, specimenId);
  getZone(state, specimenId, draft.zoneId);
  if (!draft.purpose.trim()) badRequest("研究目的不能为空");
  if (!draft.locationNotes.trim()) badRequest("取样位置说明不能为空");
  if (!Number.isFinite(draft.estimatedMassMg) || draft.estimatedMassMg <= 0) {
    badRequest("预计质量必须为正数（mg）");
  }
  if (!SAMPLING_METHODS.includes(draft.method)) {
    badRequest(`检测方法必须是 ${SAMPLING_METHODS.join(" / ")} 之一`);
  }
  if (!Array.isArray(draft.deliverables) || draft.deliverables.some((item) => !item.trim())) {
    badRequest("成果返还承诺至少包含一项返还物");
  }
  if (Number.isNaN(Date.parse(draft.resultReturnBy))) {
    badRequest("成果返还承诺日期格式无效");
  }
  if (!Number.isInteger(draft.confidentialityMonths) || draft.confidentialityMonths < 0) {
    badRequest("保密期限必须为非负整数（月）");
  }
}

function releaseHold(
  state: ServiceState,
  requestId: string,
  reason: string,
  now: Date,
): MaterialHold | undefined {
  const hold = Object.values(state.holds).find(
    (item) => item.requestId === requestId && item.status === "held",
  );
  if (hold) {
    hold.status = "released";
    hold.releasedAt = iso(now);
    hold.releaseReason = reason;
  }
  return hold;
}

function activeHold(state: ServiceState, requestId: string): MaterialHold | undefined {
  return Object.values(state.holds).find(
    (item) => item.requestId === requestId && item.status === "held",
  );
}

function draftSignature(draft: ApplicationDraft): string {
  return JSON.stringify([
    draft.purpose.trim(),
    draft.zoneId,
    draft.locationNotes.trim(),
    draft.estimatedMassMg,
    draft.method,
    draft.deliverables.map((item) => item.trim()).sort(),
    draft.resultReturnBy,
    draft.confidentialityMonths,
  ]);
}

function draftToVersion(draft: ApplicationDraft, versionNo: number, now: Date): ApplicationVersion {
  return {
    ...structuredClone(draft),
    id: newId("ver", now),
    versionNo,
    createdAt: iso(now),
    decision: "pending",
  };
}

/** 把版本推进为最终拒绝/超时（预留随之释放）。 */
function finalizeRejection(
  state: ServiceState,
  application: Application,
  version: ApplicationVersion,
  reason: string,
  by: string[],
  now: Date,
): void {
  version.decision = reason === "review_timeout" ? "timeout" : "rejected";
  version.decisionRecord = {
    kind: "rejected",
    at: iso(now),
    by,
    ruleVersion: RULES.ruleVersion,
    reason,
    pathSnapshot: version.reviewPath ? structuredClone(version.reviewPath.stages) : [],
  };
  if (version.reviewPath) version.reviewPath.status = "completed";
  application.state = "rejected";
  releaseHold(state, application.id, reason, now);
}

export class DecisionService {
  constructor(
    private readonly store: DomainStore,
    private readonly clock: Clock,
  ) {}

  // ---------- 基础数据（管理员） ----------

  createSpecimen(actor: Actor, input: Omit<Specimen, "id" | "createdAt"> & { id?: string | undefined }): Promise<Specimen> {
    requireRole(actor, "admin");
    const now = this.clock();
    return this.store.mutate(actor.userId, "specimen_created", (state) => {
      const id = input.id ?? newId("spm", now);
      if (state.specimens[id]) conflict("specimen_exists", `标本 ${id} 已存在`);
      const specimen: Specimen = {
        id,
        code: input.code,
        name: input.name,
        zones: input.zones.map((zone) => ({ ...zone })),
        createdAt: iso(now),
      };
      state.specimens[id] = specimen;
      return structuredClone(specimen);
    }, { specimenCode: input.code });
  }

  addZone(actor: Actor, specimenId: string, zone: Omit<SpecimenZone, never>): Promise<SpecimenZone> {
    requireRole(actor, "admin");
    return this.store.mutate(actor.userId, "zone_added", (state) => {
      const specimen = getSpecimen(state, specimenId);
      if (specimen.zones.some((item) => item.id === zone.id)) {
        conflict("zone_exists", `分区 ${zone.id} 已存在`);
      }
      specimen.zones.push({ ...zone });
      return structuredClone(zone);
    }, { specimenId, zoneId: zone.id });
  }

  upsertReviewer(actor: Actor, reviewer: Omit<Reviewer, never>): Promise<Reviewer> {
    requireRole(actor, "admin");
    return this.store.mutate(actor.userId, "reviewer_upserted", (state) => {
      state.reviewers[reviewer.id] = structuredClone(reviewer);
      return structuredClone(reviewer);
    }, { reviewerId: reviewer.id });
  }

  // ---------- 研究人员：申请与版本 ----------

  createApplication(
    actor: Actor,
    input: {
      specimenId: string;
      applicantOrgId: string;
      draft: ApplicationDraft;
    },
  ): Promise<Application> {
    requireRole(actor, "researcher");
    const { specimenId, applicantOrgId, draft } = input;
    const now = this.clock();
    return this.store.mutate(actor.userId, "application_created", (state) => {
      validateDraft(state, specimenId, draft);
      state.counters.application += 1;
      const seq = String(state.counters.application).padStart(4, "0");
      const id = `APL-${now.getUTCFullYear()}-${seq}`;
      const application: Application = {
        id,
        applicantUserId: actor.userId,
        applicantOrgId,
        specimenId,
        state: "draft",
        currentVersionNo: 1,
        versions: [draftToVersion(draft, 1, now)],
        supplements: [],
        createdAt: iso(now),
        updatedAt: iso(now),
      };
      state.applications[id] = application;
      return structuredClone(application);
    }, { specimenId });
  }

  /** 送审前修改：就地更新草稿版本；送审后修改：生成新版本。 */
  reviseApplication(
    actor: Actor,
    requestId: string,
    draft: ApplicationDraft,
  ): Promise<{ application: Application; newVersion: boolean }> {
    requireRole(actor, "researcher");
    const now = this.clock();
    return this.store.mutate(actor.userId, "application_revised", (state) => {
      const application = getApplication(state, requestId);
      if (application.applicantUserId !== actor.userId) forbidden("只能修改本人申请");
      validateDraft(state, application.specimenId, draft);
      const version = currentVersion(application);
      let createdNewVersion = false;

      if (application.state === "draft" && version.decision === "pending" && !version.submittedAt) {
        // 尚未送审：原地改草稿。
        Object.assign(version, structuredClone(draft));
      } else if (["submitted", "reviewing"].includes(application.state)) {
        if (draftSignature(version) === draftSignature(draft)) {
          return { application: structuredClone(application), newVersion: false };
        }
        // 送审后关键参数变化：冻结旧版本，释放其预留，另起新版本。
        version.decision = "superseded";
        if (version.reviewPath) version.reviewPath.status = "completed";
        releaseHold(state, application.id, "superseded", now);

        const next = draftToVersion(draft, version.versionNo + 1, now);
        application.versions.push(next);
        application.currentVersionNo = next.versionNo;
        application.state = "draft";
        // 未结补件项随新版本流转，仍需申请人回应。
        for (const item of application.supplements) {
          if (item.versionNo === version.versionNo && item.status === "open") {
            item.versionNo = next.versionNo;
          }
        }
        createdNewVersion = true;
      } else {
        conflict(
          "revision_not_allowed",
          `申请处于 ${application.state} 状态，不能修改；如需再次取样请新建申请`,
        );
      }
      application.updatedAt = iso(now);
      return { application: structuredClone(application), newVersion: createdNewVersion };
    }, { requestId, newVersionKeyParams: draft });
  }

  submitApplication(
    actor: Actor,
    requestId: string,
  ): Promise<{ application: Application; reviewPath: ReviewPath; hold?: MaterialHold }> {
    requireRole(actor, "researcher");
    const now = this.clock();
    return this.store.mutate(actor.userId, "application_submitted", (state) => {
      const application = getApplication(state, requestId);
      if (application.applicantUserId !== actor.userId) forbidden("只能送审本人申请");
      if (application.state !== "draft") {
        conflict("not_draft", `申请当前为 ${application.state}，不能送审`);
      }
      const version = currentVersion(application);
      if (version.submittedAt) conflict("already_submitted", "该版本已送审");
      const openItems = application.supplements.filter(
        (item) => item.versionNo === version.versionNo && item.status === "open",
      );
      if (openItems.length > 0) {
        conflict("supplements_open", "尚有补件项未回应", { itemIds: openItems.map((item) => item.id) });
      }

      const blocker = reservationBlocker(state, application.specimenId, version.zoneId, version.estimatedMassMg);
      if (blocker) conflict("material_unavailable", blocker);

      const zone = getZone(state, application.specimenId, version.zoneId);
      const path = generatePath(
        state,
        application,
        application.specimenId,
        version.zoneId,
        version.estimatedMassMg,
        zone.reinforced,
        now,
      );
      version.reviewPath = path;
      version.submittedAt = iso(now);

      let hold: MaterialHold | undefined;
      if (path.status === "active") {
        hold = this.placeHold(state, application, version, now);
        application.state = "reviewing";
      } else {
        // 回避导致人数不足：暂不预占材料，等待管理员增补委员后重建路径。
        application.state = "submitted";
      }
      application.updatedAt = iso(now);
      return {
        application: structuredClone(application),
        reviewPath: structuredClone(path),
        ...(hold ? { hold: structuredClone(hold) } : {}),
      };
    }, { requestId });
  }

  private placeHold(
    state: ServiceState,
    application: Application,
    version: ApplicationVersion,
    now: Date,
  ): MaterialHold {
    const blocker = reservationBlocker(state, application.specimenId, version.zoneId, version.estimatedMassMg);
    if (blocker) conflict("material_unavailable", blocker);
    const hold: MaterialHold = {
      id: newId("hld", now),
      requestId: application.id,
      versionId: version.id,
      specimenId: application.specimenId,
      zoneId: version.zoneId,
      massMg: version.estimatedMassMg,
      status: "held",
      createdAt: iso(now),
    };
    state.holds[hold.id] = hold;
    return hold;
  }

  /** 管理员增补委员后，为仍被回避阻塞的申请重建评审路径（原子地补做预留）。 */
  regeneratePath(actor: Actor, requestId: string): Promise<ReviewPath> {
    requireRole(actor, "admin");
    const now = this.clock();
    return this.store.mutate(actor.userId, "review_path_regenerated", (state) => {
      const application = getApplication(state, requestId);
      const version = currentVersion(application);
      if (!version.reviewPath || version.reviewPath.status !== "blocked_recusal") {
        conflict("path_not_blocked", "当前路径未被回避阻塞，无需重建");
      }
      const zone = getZone(state, application.specimenId, version.zoneId);
      const path = generatePath(
        state,
        application,
        application.specimenId,
        version.zoneId,
        version.estimatedMassMg,
        zone.reinforced,
        now,
      );
      if (path.status === "blocked_recusal") {
        conflict("still_blocked", blockReason(path) ?? "评审路径仍因回避人数不足被阻塞");
      }
      const blocker = reservationBlocker(state, application.specimenId, version.zoneId, version.estimatedMassMg);
      if (blocker) conflict("material_unavailable", blocker);
      version.reviewPath = path;
      if (!activeHold(state, application.id)) {
        this.placeHold(state, application, version, now);
      }
      application.state = "reviewing";
      application.updatedAt = iso(now);
      return structuredClone(path);
    }, { requestId });
  }

  withdrawApplication(actor: Actor, requestId: string): Promise<Application> {
    requireRole(actor, "researcher");
    const now = this.clock();
    return this.store.mutate(actor.userId, "application_withdrawn", (state) => {
      const application = getApplication(state, requestId);
      if (application.applicantUserId !== actor.userId) forbidden("只能撤回本人申请");
      if (!["draft", "submitted", "reviewing"].includes(application.state)) {
        conflict("withdraw_not_allowed", `申请处于 ${application.state}，不能撤回`);
      }
      const version = currentVersion(application);
      version.decision = "withdrawn";
      if (version.reviewPath) version.reviewPath.status = "completed";
      application.state = "withdrawn";
      releaseHold(state, application.id, "withdrawn", now);
      application.updatedAt = iso(now);
      return structuredClone(application);
    }, { requestId });
  }

  // ---------- 补件 ----------

  submitSupplement(
    actor: Actor,
    requestId: string,
    itemId: string,
    response: string,
  ): Promise<SupplementItem> {
    requireRole(actor, "researcher");
    if (!response.trim()) badRequest("补件回应不能为空");
    const now = this.clock();
    return this.store.mutate(actor.userId, "supplement_submitted", (state) => {
      const application = getApplication(state, requestId);
      if (application.applicantUserId !== actor.userId) forbidden("只能回应本人申请的补件项");
      const item = application.supplements.find((entry) => entry.id === itemId);
      if (!item) notFound(`补件项 ${itemId} 不存在`);
      if (item.status !== "open") conflict("item_closed", `补件项已为 ${item.status}`);
      item.status = "submitted";
      item.response = response;
      const version = currentVersion(application);
      const stillOpen = application.supplements.some(
        (entry) => entry.versionNo === version.versionNo && entry.status === "open",
      );
      if (!stillOpen && version.reviewPath?.awaitingSupplementAtStage !== undefined) {
        version.reviewPath.awaitingSupplementAtStage = undefined;
      }
      application.updatedAt = iso(now);
      return structuredClone(item);
    }, { requestId, itemId });
  }

  // ---------- 评审投票 ----------

  castVote(
    actor: Actor,
    requestId: string,
    value: Vote["value"],
    input: { comment?: string | undefined; supplementField?: string | undefined; supplementNote?: string | undefined } = {},
  ): Promise<Application> {
    requireRole(actor, "reviewer");
    const now = this.clock();
    return this.store.mutate(actor.userId, "vote_cast", (state) => {
      const application = getApplication(state, requestId);
      if (!["submitted", "reviewing"].includes(application.state)) {
        conflict("not_in_review", `申请处于 ${application.state}，不在评审中`);
      }
      this.checkTimeout(state, application, now);
      if (application.state === "rejected") {
        conflict("review_timeout", "审批已超时结案");
      }
      const version = currentVersion(application);
      const path = version.reviewPath;
      if (!path || path.status !== "active") conflict("path_inactive", "评审路径未激活");
      if (path.awaitingSupplementAtStage !== undefined) {
        conflict("awaiting_supplement", "等待申请人补件，暂不能推进投票");
      }
      const reviewer = state.reviewers[actor.userId];
      if (!reviewer) forbidden("委员名册中不存在该用户");
      if (conflictsWith(reviewer, application.applicantUserId, application.applicantOrgId)) {
        forbidden("存在回避关系，不能参与本申请表决");
      }
      const stageIndex = path.stages.findIndex((stage) => stage.outcome === undefined);
      if (stageIndex < 0) conflict("review_complete", "各阶段均已表决");
      const stage = path.stages[stageIndex]!;
      if (!stage.pool.includes(actor.userId)) forbidden("您不在本阶段的表决名单中");
      if (stage.votes.some((vote) => vote.reviewerId === actor.userId && vote.round === path.round)) {
        conflict("already_voted", "本轮您已表决");
      }

      if (value === "request_changes") {
        const field = input.supplementField?.trim();
        const note = input.supplementNote?.trim() || input.comment?.trim();
        if (!field || !note) badRequest("要求补件必须指明字段与说明（supplementField / supplementNote）");
        const item: SupplementItem = {
          id: newId("sup", now),
          versionNo: version.versionNo,
          field,
          note,
          requestedBy: actor.userId,
          status: "open",
          createdAt: iso(now),
        };
        application.supplements.push(item);
        path.awaitingSupplementAtStage = stageIndex;
        path.round += 1;
        stage.votes.push({ reviewerId: actor.userId, value, comment: input.comment, round: path.round - 1, at: iso(now), ruleVersion: RULES.ruleVersion });
        application.updatedAt = iso(now);
        return structuredClone(application);
      }

      stage.votes.push({
        reviewerId: actor.userId,
        value,
        comment: input.comment,
        round: path.round,
        at: iso(now),
        ruleVersion: RULES.ruleVersion,
      });

      this.advanceReview(state, application, version, stage, stageIndex, now);
      application.updatedAt = iso(now);
      return structuredClone(application);
    }, { requestId, value });
  }

  /** 根据当前阶段与新投票判定阶段结论，必要时推进/终审。 */
  private advanceReview(
    state: ServiceState,
    application: Application,
    version: ApplicationVersion,
    stage: ReviewStage,
    stageIndex: number,
    now: Date,
  ): void {
    const path = version.reviewPath!;
    const roundVotes = stage.votes.filter((vote) => vote.round === path.round);

    if (stage.name === "committee_review") {
      const approvals = roundVotes.filter((vote) => vote.value === "approve").length;
      const rejects = roundVotes.filter((vote) => vote.value === "reject").length;
      // 满法定人数即结算；赞成票严格多于反对票才通过（平票从紧，保护稀缺材料）。
      if (approvals + rejects < RULES.committeeQuorum) return;
      if (approvals > rejects) {
        stage.outcome = "approved";
        stage.decidedBy = roundVotes.filter((vote) => vote.value === "approve").map((vote) => vote.reviewerId);
      } else {
        stage.outcome = "rejected";
        stage.decidedBy = roundVotes.map((vote) => vote.reviewerId);
      }
    } else {
      // sole_review / director_signoff：池内一人一票定阶段。
      const vote = roundVotes[roundVotes.length - 1]!;
      stage.outcome = vote.value === "approve" ? "approved" : "rejected";
      stage.decidedBy = [vote.reviewerId];
    }

    if (stage.outcome === "rejected") {
      const reason =
        stage.name === "committee_review"
          ? "committee_vote"
          : stage.name === "director_signoff"
            ? "director_rejected"
            : "sole_reviewer_rejected";
      finalizeRejection(state, application, version, reason, stage.decidedBy ?? [], now);
      return;
    }

    const nextStage = path.stages.slice(stageIndex + 1).find((item) => item.outcome === undefined);
    if (nextStage) return;

    // 全部阶段通过 → 批准（结论冻结，事后不可改）。
    path.status = "completed";
    state.counters.approval += 1;
    const seq = String(state.counters.approval).padStart(4, "0");
    const submittedAt = new Date(version.submittedAt ?? iso(now));
    const expiresAt = plusDays(now, RULES.approvalValidDays);
    version.decision = "approved";
    version.decisionRecord = {
      kind: "approved",
      approvalNo: `APV-${now.getUTCFullYear()}-${seq}`,
      at: iso(now),
      by: path.stages.flatMap((item) => item.decidedBy ?? []),
      ruleVersion: RULES.ruleVersion,
      approvedMassMg: version.estimatedMassMg,
      approvalExpiresAt: iso(expiresAt),
      confidentialityUntil: iso(plusMonths(submittedAt, version.confidentialityMonths)),
      pathSnapshot: structuredClone(path.stages),
    };
    for (const item of application.supplements) {
      if (item.versionNo === version.versionNo && item.status === "submitted") {
        item.status = "accepted";
        item.resolvedAt = iso(now);
      }
    }
    application.result = {
      dueAt: version.resultReturnBy,
      state: this.resultState(version.resultReturnBy, now),
      deliverables: structuredClone(version.deliverables),
    };
    application.state = "approved";
    void submittedAt;
  }

  // ---------- 超时与批准有效期 ----------

  /** SLA 超时：未决申请自动拒绝并释放预留；批准逾期未取样：仅释放预留，结论保留。 */
  private checkTimeout(state: ServiceState, application: Application, now: Date): void {
    const version = currentVersion(application);
    if (["submitted", "reviewing"].includes(application.state) && version.submittedAt) {
      const deadline = plusDays(new Date(version.submittedAt), RULES.reviewSlaDays);
      if (now.getTime() > deadline.getTime()) {
        finalizeRejection(state, application, version, "review_timeout", ["system:sla"], now);
      }
    }
  }

  /** 批量巡检（可由定时任务/管理员接口触发），返回受影响申请。 */
  sweepTimeouts(actor: Actor): Promise<{ timedOut: string[]; approvalExpired: string[] }> {
    if (!actor.roles.includes("reviewer") && !actor.roles.includes("admin")) forbidden("需要 reviewer 或 admin 角色");
    const now = this.clock();
    return this.store.mutate(actor.userId, "timeout_sweep", (state) => {
      const timedOut: string[] = [];
      const approvalExpired: string[] = [];
      for (const application of Object.values(state.applications)) {
        if (["submitted", "reviewing"].includes(application.state)) {
          const before = application.state;
          this.checkTimeout(state, application, now);
          if (application.state !== before) timedOut.push(application.id);
          continue;
        }
        if (application.state === "approved") {
          const version = currentVersion(application);
          const expiresAt = version.decisionRecord?.approvalExpiresAt;
          const alreadyCut = state.cuttings.some((cutting) => cutting.requestId === application.id);
          if (expiresAt && !alreadyCut && now.getTime() > new Date(expiresAt).getTime() && activeHold(state, application.id)) {
            releaseHold(state, application.id, "approval_expired", now);
            approvalExpired.push(application.id);
          }
        }
      }
      return { timedOut, approvalExpired };
    }, null);
  }

  // ---------- 实际取样与偏差 ----------

  recordCutting(
    actor: Actor,
    requestId: string,
    input: { actualMassMg: number; actualMethod: SamplingMethod; sampledAt?: string | undefined; note?: string | undefined },
  ): Promise<CuttingRecord> {
    requireRole(actor, "admin");
    const now = this.clock();
    return this.store.mutate(actor.userId, "cutting_recorded", (state) => {
      const application = getApplication(state, requestId);
      if (application.state !== "approved") conflict("not_approved", `申请处于 ${application.state}，不能登记取样`);
      const version = currentVersion(application);
      const record = version.decisionRecord;
      if (!record || record.kind !== "approved" || record.approvedMassMg === undefined) {
        conflict("no_approval", "缺少有效批准结论");
      }
      if (record.approvalExpiresAt && now.getTime() > new Date(record.approvalExpiresAt).getTime()) {
        conflict("approval_expired", "批准已过有效期，预留已释放");
      }
      if (!Number.isFinite(input.actualMassMg) || input.actualMassMg <= 0) {
        badRequest("实际取样质量必须为正数（mg）");
      }
      if (!SAMPLING_METHODS.includes(input.actualMethod)) badRequest("实际检测方法无效");
      if (state.cuttings.some((cutting) => cutting.requestId === requestId)) {
        conflict("cutting_exists", "该申请已登记取样；偏差请追加记录，不能重复登记");
      }
      const availability = zoneAvailability(state, application.specimenId, version.zoneId);
      if (availability.availableMassMg + 1e-9 < input.actualMassMg) {
        conflict(
          "physical_material_exceeded",
          `分区实物余量仅 ${availability.availableMassMg}mg，无法实取 ${input.actualMassMg}mg`,
        );
      }
      const sampledAt = input.sampledAt ?? iso(now);
      const approvedMass = record.approvedMassMg;
      const delta = input.actualMassMg - approvedMass;
      const percent = (delta / approvedMass) * 100;
      const cutting: CuttingRecord = {
        id: newId("cut", now),
        requestId: application.id,
        versionId: version.id,
        specimenId: application.specimenId,
        zoneId: version.zoneId,
        approvedMassMg: approvedMass,
        actualMassMg: input.actualMassMg,
        approvedMethod: version.method,
        actualMethod: input.actualMethod,
        sampledAt,
        recordedAt: iso(now),
        recordedBy: actor.userId,
        variance: {
          ruleVersion: RULES.ruleVersion,
          approvedMassMg: approvedMass,
          actualMassMg: input.actualMassMg,
          deltaMg: Number(delta.toFixed(6)),
          percent: Number(percent.toFixed(4)),
          withinTolerance: Math.abs(percent) <= RULES.massTolerancePercent,
          methodMatchesApproved: input.actualMethod === version.method,
          note: input.note,
        },
      };
      state.cuttings.push(cutting);

      // 预留以实际量结算：关闭预占；余量由切割记录重算（不修改批准结论）。
      const hold = activeHold(state, application.id);
      if (hold) {
        hold.status = "consumed";
        hold.consumedAt = iso(now);
        hold.settledMassMg = input.actualMassMg;
      }
      application.updatedAt = iso(now);
      return structuredClone(cutting);
    }, { requestId, actualMassMg: input.actualMassMg, actualMethod: input.actualMethod });
  }

  // ---------- 成果返还 ----------

  confirmResultReceived(actor: Actor, requestId: string, note?: string | undefined): Promise<Application> {
    requireRole(actor, "admin");
    const now = this.clock();
    return this.store.mutate(actor.userId, "result_received", (state) => {
      const application = getApplication(state, requestId);
      if (!application.result) conflict("no_result_due", "该申请没有成果返还义务（尚未批准）");
      if (application.result.state === "received") conflict("already_received", "成果已登记接收");
      application.result.state = "received";
      application.result.receivedAt = iso(now);
      application.result.receivedNote = note;
      application.updatedAt = iso(now);
      return structuredClone(application);
    }, { requestId });
  }

  private resultState(dueAt: string, now: Date): ResultState {
    const due = new Date(dueAt);
    if (now.getTime() > due.getTime()) return "overdue";
    if (due.getTime() - now.getTime() <= RULES.resultDueSoonDays * 24 * 60 * 60 * 1000) return "due";
    return "not_due";
  }

  /** 刷新成果时效状态（不产生结论变化，仅 due/overdue 派生状态）。 */
  refreshResultStates(actor: Actor): Promise<{ overdue: string[]; due: string[] }> {
    if (!actor.roles.includes("reviewer") && !actor.roles.includes("admin")) forbidden("需要 reviewer 或 admin 角色");
    const now = this.clock();
    return this.store.mutate(actor.userId, "result_states_refreshed", (state) => {
      const overdue: string[] = [];
      const due: string[] = [];
      for (const application of Object.values(state.applications)) {
        if (!application.result || application.result.state === "received") continue;
        const next = this.resultState(application.result.dueAt, now);
        application.result.state = next;
        if (next === "overdue") overdue.push(application.id);
        if (next === "due") due.push(application.id);
      }
      return { overdue, due };
    }, null);
  }
}
