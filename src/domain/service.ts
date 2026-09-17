import type {
  Application,
  ApplicationEvent,
  ApplicationVersion,
  CuttingRecord,
  DataState,
  DeviationRecord,
  ReviewStep,
  ResultState,
  SamplingMethod,
  SupplementRequest,
  User,
} from "./types.js";
import { DomainError, fail } from "./errors.js";
import { addDays, addHours, iso, isFinitePositiveNumber, newId } from "./ids.js";
import { getRule, latestRuleVersion, resolveReviewMode, type RuleSet } from "./rules.js";
import { computeBalance, mustRecuse, round3 } from "./quota.js";
import type { Store } from "./store.js";

export interface ApplicationInput {
  applicantId: string;
  specimenId: string;
  purpose: string;
  zoneId: string;
  plannedMassMg: number;
  method: SamplingMethod;
  deliverable: string;
  resultDueDays: number;
  confidentialityMonths: number;
}

export interface ApplicantView {
  applicationId: string;
  state: string;
  currentVersionNo: number;
  blockedReason: string | null;
  reviewDeadline: string | null;
  versions: ApplicationVersion[];
  steps: { stepNo: number; kind: string; assigneeId: string; status: string }[];
  supplements: SupplementRequest[];
  decisions: Application["decisions"];
  cuttings: CuttingRecord[];
  deviations: DeviationRecord[];
  result: Application["result"];
  events: ApplicationEvent[];
}

export class SamplingService {
  constructor(private readonly store: Store) {}

  // ---------------- 管理类操作 ----------------

  createUser(user: User): Promise<User> {
    return this.store.mutate(() => {
      this.store.state.users[user.id] = user;
      return user;
    });
  }

  addRecusal(input: {
    reviewerId: string;
    applicantId?: string | undefined;
    institutionId?: string | undefined;
    reason: string;
  }): Promise<DataState["recusals"][number]> {
    return this.store.mutate(() => {
      const recusal = {
        id: newId("rec"),
        reviewerId: input.reviewerId,
        applicantId: input.applicantId ?? null,
        institutionId: input.institutionId ?? null,
        reason: input.reason,
        createdAt: iso(new Date()),
      };
      this.store.state.recusals.push(recusal);
      return recusal;
    });
  }

  createSpecimen(input: {
    id: string;
    name: string;
    initialMassMg: number;
    zones: { id: string; name: string; reinforced: boolean; initialMassMg: number }[];
  }): Promise<DataState["specimens"][string]> {
    return this.store.mutate(() => {
      if (this.store.state.specimens[input.id]) fail("conflict", "标本已存在", 409);
      const zonesSum = input.zones.reduce((a, z) => a + z.initialMassMg, 0);
      if (Math.abs(zonesSum - input.initialMassMg) > 0.001) {
        fail("validation_error", "分区初始质量之和必须等于标本初始质量", 400, {
          zonesSum,
          specimenMass: input.initialMassMg,
        });
      }
      const specimen = { ...input, createdAt: iso(new Date()) };
      this.store.state.specimens[input.id] = specimen;
      return specimen;
    });
  }

  // ---------------- 申请 ----------------

  createApplication(input: ApplicationInput, now = new Date()): Application {
    this.validateInput(input);
    const state = this.store.state;
    const applicant = state.users[input.applicantId];
    if (!applicant) fail("not_found", "申请人不存在", 404);
    const specimen = state.specimens[input.specimenId];
    if (!specimen) fail("not_found", "标本不存在", 404);
    if (!specimen.zones.some((z) => z.id === input.zoneId)) {
      fail("validation_error", `标本上不存在取样区: ${input.zoneId}`);
    }

    const app: Application = {
      id: newId("app"),
      applicantId: input.applicantId,
      institutionId: applicant.institutionId,
      specimenId: input.specimenId,
      state: "draft",
      currentVersionNo: 0,
      versions: [],
      steps: [],
      decisions: [],
      supplements: [],
      cuttings: [],
      deviations: [],
      result: null,
      blockedReason: null,
      reviewDeadline: null,
      submittedAt: null,
      finalizedAt: null,
      terminalReason: null,
      sampledAt: null,
      events: [],
    };
    state.applications[app.id] = app;
    app.versions.push(this.buildVersion(1, input, now, false));
    app.currentVersionNo = 1;
    this.pushEvent(app, "draft_created", input.applicantId, { versionNo: 1 }, now);
    return app;
  }

  /** 首次送审。 */
  submit(applicationId: string, actorId: string, now = new Date()): Promise<Application> {
    return this.mutateApp(applicationId, actorId, (app) => {
      if (app.state !== "draft") fail("conflict", `当前状态 ${app.state} 不能送审`, 409);
      const v = this.currentVersion(app);
      this.routeIntoReview(app, v, now);
      return app;
    });
  }

  /**
   * 送审后改动关键参数：产生新版本。旧版本、旧步骤、旧决定全部保留；
   * 旧预占按旧版本关闭而释放，新版本重新通过额度校验并重新路由。
   */
  amend(
    applicationId: string,
    actorId: string,
    changes: Partial<Pick<ApplicationInput,
      "purpose" | "zoneId" | "plannedMassMg" | "method" |
      "deliverable" | "resultDueDays" | "confidentialityMonths">>,
    now = new Date(),
  ): Promise<Application> {
    return this.mutateApp(applicationId, actorId, (app, actor) => {
      if (actor.id !== app.applicantId) fail("forbidden", "仅申请人可修改申请", 403);
      if (app.state !== "reviewing" && app.state !== "submitted") {
        fail("conflict", `当前状态 ${app.state} 不允许修改关键参数`, 409);
      }
      const old = this.currentVersion(app);
      const oldInput = this.versionToInput(app, old);
      const merged = { ...oldInput, ...stripUndefined(changes) };
      this.validateInput(merged);
      const specimen = this.store.state.specimens[app.specimenId]!;
      if (!specimen.zones.some((z) => z.id === merged.zoneId)) {
        fail("validation_error", `标本上不存在取样区: ${merged.zoneId}`);
      }

      old.superseded = true;
      for (const step of app.steps) {
        if (step.versionNo === old.versionNo && (step.status === "pending" || step.status === "waiting_supplement")) {
          step.status = "closed";
          step.decidedAt = iso(now);
        }
      }
      const versionNo = old.versionNo + 1;
      const v = this.buildVersion(versionNo, merged, now, false);
      app.versions.push(v);
      app.currentVersionNo = versionNo;
      app.blockedReason = null;
      this.pushEvent(app, "amended", actorId, {
        fromVersion: old.versionNo,
        toVersion: versionNo,
        changedFields: Object.keys(changes),
      }, now);

      // 旧预占随旧版本关闭释放；新版本重新做额度校验与路由（仍可能挂起）。
      this.routeIntoReview(app, v, now, /* resubmit */ true);
      return app;
    });
  }

  withdraw(applicationId: string, actorId: string, now = new Date()): Promise<Application> {
    return this.mutateApp(applicationId, actorId, (app, actor) => {
      if (actor.id !== app.applicantId) fail("forbidden", "仅申请人可撤回", 403);
      if (app.state !== "submitted" && app.state !== "reviewing") {
        fail("conflict", `当前状态 ${app.state} 不能撤回`, 409);
      }
      this.closeOpenSteps(app, now);
      app.state = "withdrawn";
      app.finalizedAt = iso(now);
      app.terminalReason = "applicant_withdrawn";
      app.reviewDeadline = null;
      this.pushEvent(app, "withdrawn", actorId, null, now);
      return app;
    });
  }

  /** 无法形成法定人数而挂起后，管理员补充委员可重新路由。 */
  retryRouting(applicationId: string, actorId: string, now = new Date()): Promise<Application> {
    return this.mutateApp(applicationId, actorId, (app, actor) => {
      if (actor.role !== "admin") fail("forbidden", "仅管理员可重新路由", 403);
      if (app.state !== "submitted" || !app.blockedReason) {
        fail("conflict", "申请当前未处于挂起状态", 409);
      }
      this.routeIntoReview(app, this.currentVersion(app), now);
      return app;
    });
  }

  // ---------------- 补件 ----------------

  requestSupplement(
    applicationId: string,
    actorId: string,
    items: string[],
    reason: string,
    now = new Date(),
  ): Promise<SupplementRequest> {
    return this.mutateApp(applicationId, actorId, (app, actor) => {
      const step = this.requireOpenStep(app, actor.id);
      if (items.length === 0) fail("validation_error", "补件项不能为空");
      step.status = "waiting_supplement";
      const sup: SupplementRequest = {
        id: newId("sup"),
        applicationId: app.id,
        stepId: step.id,
        versionNo: step.versionNo,
        requestedBy: actorId,
        items,
        reason,
        status: "requested",
        createdAt: iso(now),
        submittedAt: null,
        response: "",
      };
      app.supplements.push(sup);
      this.pushEvent(app, "supplement_requested", actorId, {
        stepId: step.id,
        items,
      }, now);
      return sup;
    });
  }

  submitSupplement(
    applicationId: string,
    supplementId: string,
    actorId: string,
    response: string,
    now = new Date(),
  ): Promise<SupplementRequest> {
    return this.mutateApp(applicationId, actorId, (app, actor) => {
      if (actor.id !== app.applicantId) fail("forbidden", "仅申请人可提交补件", 403);
      const sup = app.supplements.find((s) => s.id === supplementId);
      if (!sup || sup.status !== "requested") fail("conflict", "补件请求不存在或已处理", 409);
      if (!response.trim()) fail("validation_error", "补件说明不能为空");
      sup.status = "submitted";
      sup.submittedAt = iso(now);
      sup.response = response;
      const step = app.steps.find((s) => s.id === sup.stepId);
      if (step && step.status === "waiting_supplement") step.status = "pending";
      this.pushEvent(app, "supplement_submitted", actorId, { supplementId }, now);
      return sup;
    });
  }

  acceptSupplement(
    applicationId: string,
    supplementId: string,
    actorId: string,
    accepted: boolean,
    comment: string,
    now = new Date(),
  ): Promise<Application> {
    return this.mutateApp(applicationId, actorId, (app) => {
      const sup = app.supplements.find((s) => s.id === supplementId);
      if (!sup || sup.status !== "submitted") fail("conflict", "补件不存在或尚未提交", 409);
      const step = app.steps.find((s) => s.id === sup.stepId);
      if (!step || step.assigneeId !== actorId) fail("forbidden", "只有发起补件的委员可受理", 403);
      if (accepted) {
        sup.status = "accepted";
        step.status = "pending";
        this.pushEvent(app, "supplement_accepted", actorId, { supplementId, comment }, now);
      } else {
        sup.status = "requested";
        step.status = "waiting_supplement";
        this.pushEvent(app, "supplement_rejected_resend", actorId, { supplementId, comment }, now);
      }
      return app;
    });
  }

  // ---------------- 决定 ----------------

  decide(
    applicationId: string,
    actorId: string,
    vote: "approve" | "reject",
    comment: string,
    now = new Date(),
  ): Promise<Application> {
    return this.mutateApp(applicationId, actorId, (app, actor) => {
      const step = this.requireOpenStep(app, actor.id);
      const rule = getRule(step.ruleVersion);
      if (
        vote === "approve" &&
        step.kind === "director" &&
        app.steps.some((s) => s.versionNo === step.versionNo && s.kind === "reviewer") &&
        this.committeeOutcome(app, step.versionNo) !== "approved"
      ) {
        fail("conflict", "委员会尚未形成赞成结论，主任不能签批", 409);
      }
      step.status = vote === "approve" ? "approved" : "rejected";
      step.decidedAt = iso(now);
      app.decisions.push({
        id: newId("dec"),
        versionNo: step.versionNo,
        stepNo: step.stepNo,
        actorId,
        actorKind: step.kind,
        vote,
        comment,
        ruleVersion: step.ruleVersion,
        reason: null,
        at: iso(now),
      });
      this.pushEvent(app, "decision_recorded", actorId, {
        stepNo: step.stepNo,
        vote,
        ruleVersion: rule.version,
      }, now);

      if (vote === "reject") {
        if (step.kind === "director") {
          this.finalizeRejection(app, actorId, "director_rejected", now);
          return app;
        }
        if (this.committeeOutcome(app, step.versionNo) === "rejected") {
          this.finalizeRejection(app, actorId, "committee_rejected", now);
        }
        // 多数制下尚未过半：等待其余委员投票。
        return app;
      }

      if (step.kind === "reviewer" && this.committeeOutcome(app, step.versionNo) !== "approved") {
        return app; // 委员会尚未形成结论
      }

      // 委员会已通过（或本票来自主任）：无主任步骤则直接通过，否则等主任签批。
      const directorStep = app.steps.find(
        (s) => s.versionNo === step.versionNo && s.kind === "director",
      );
      if (directorStep && directorStep.status !== "approved") return app;
      this.finalizeApproval(app, now);
      return app;
    });
  }

  // ---------------- 实际取样与偏差 ----------------

  recordCutting(
    applicationId: string,
    actorId: string,
    actualMassMg: number,
    sampledAtIso?: string,
    now = new Date(),
  ): Promise<{ cutting: CuttingRecord; deviation: DeviationRecord | null }> {
    return this.mutateApp(applicationId, actorId, (app, actor) => {
      if (actor.role !== "admin" && actor.id !== app.applicantId) {
        fail("forbidden", "仅管理员或申请人可登记取样", 403);
      }
      if (app.state !== "approved") fail("conflict", "只有已批准申请可登记取样", 409);
      if (app.sampledAt) fail("conflict", "该申请已有取样记录，批准结论不可修改", 409);
      if (!isFinitePositiveNumber(actualMassMg)) fail("validation_error", "实际质量必须为正数");

      const v = this.currentVersion(app);
      const sampledAt = sampledAtIso ? new Date(sampledAtIso) : now;
      // 排除自身预占后，zone.availableMg 即本次可实际动用的物理余量。
      const balance = computeBalance(this.store.state, app.specimenId, app.id);
      const zone = balance.zones.find((z) => z.zoneId === v.zoneId)!;
      if (actualMassMg > zone.availableMg + 1e-6) {
        fail("quota_unavailable", "实际取样超过该区当前物理可用余量", 409, {
          actualMassMg,
          physicalFree: round3(zone.availableMg),
        });
      }

      const rule = getRule(v.ruleVersion);
      const cutting: CuttingRecord = {
        id: newId("cut"),
        applicationId: app.id,
        versionNo: v.versionNo,
        specimenId: app.specimenId,
        zoneId: v.zoneId,
        method: v.method,
        plannedMassMg: v.plannedMassMg,
        actualMassMg: round3(actualMassMg),
        sampledAt: iso(sampledAt),
        ruleVersion: v.ruleVersion,
        deviationId: null,
      };

      let deviation: DeviationRecord | null = null;
      const delta = round3(actualMassMg - v.plannedMassMg);
      if (delta !== 0) {
        const ratio = Math.abs(delta) / v.plannedMassMg;
        deviation = {
          id: newId("dev"),
          cuttingRecordId: cutting.id,
          applicationId: app.id,
          plannedMassMg: v.plannedMassMg,
          actualMassMg: round3(actualMassMg),
          deltaMg: delta,
          ratio: round3(ratio),
          withinTolerance: ratio <= rule.deviationToleranceRatio,
          note: "",
          recordedAt: iso(now),
        };
        cutting.deviationId = deviation.id;
        app.deviations.push(deviation);
      }
      app.cuttings.push(cutting);
      app.sampledAt = iso(sampledAt);

      // 成果承诺进入计时；批准结论不变，仅追加记录并重算余量。
      app.result = {
        deliverable: v.resultPromise.deliverable,
        dueDays: v.resultPromise.dueDays,
        promisedAt: iso(now),
        dueAt: iso(addDays(sampledAt, v.resultPromise.dueDays)),
        receivedAt: null,
        state: "not_due",
      };
      this.pushEvent(app, "cutting_recorded", actorId, {
        cuttingId: cutting.id,
        planned: v.plannedMassMg,
        actual: round3(actualMassMg),
        deviation: deviation
          ? { withinTolerance: deviation.withinTolerance, ratio: deviation.ratio }
          : null,
      }, now);
      return { cutting, deviation };
    });
  }

  receiveResult(applicationId: string, actorId: string, now = new Date()): Promise<Application> {
    return this.mutateApp(applicationId, actorId, (app, actor) => {
      if (actor.role !== "admin") fail("forbidden", "仅管理员可登记成果返还", 403);
      if (!app.result || !app.result.dueAt) fail("conflict", "尚无取样，成果承诺未开始计时", 409);
      if (app.result.receivedAt) fail("conflict", "成果已登记返还", 409);
      app.result.receivedAt = iso(now);
      app.result.state = "received";
      this.pushEvent(app, "result_received", actorId, { at: iso(now) }, now);
      return app;
    });
  }

  /** 扫描超时在途申请：超时即驳回并释放预占。 */
  expireTimedOut(now = new Date()): Promise<Application[]> {
    return this.store.mutate(() => {
      const due = Object.values(this.store.state.applications).filter(
        (app) =>
          app.state === "reviewing" &&
          app.reviewDeadline !== null &&
          new Date(app.reviewDeadline).getTime() <= now.getTime(),
      );
      for (const app of due) this.expireOne(app, now);
      return due;
    });
  }

  // ---------------- 查询视图 ----------------

  applicantView(applicationId: string, actorId: string): ApplicantView {
    const app = this.requireApp(applicationId);
    const actor = this.store.state.users[actorId];
    if (!actor) fail("not_found", "用户不存在", 404);
    if (actor.role !== "admin" && actor.id !== app.applicantId) {
      fail("forbidden", "只能查看本人申请", 403);
    }
    return {
      applicationId: app.id,
      state: app.state,
      currentVersionNo: app.currentVersionNo,
      blockedReason: app.blockedReason,
      reviewDeadline: app.reviewDeadline,
      versions: app.versions,
      steps: app.steps.map((s) => ({
        stepNo: s.stepNo,
        kind: s.kind,
        assigneeId: s.assigneeId,
        status: s.status,
      })),
      supplements: app.supplements,
      decisions: app.decisions,
      cuttings: app.cuttings,
      deviations: app.deviations,
      result: app.result ? { ...app.result, state: this.resultStateAt(app, new Date()) } : null,
      events: app.events,
    };
  }

  /** 管理员：标本余量追溯——余量、预占、切割、决定、规则版本、成果到期。 */
  specimenTrace(specimenId: string, now = new Date()) {
    const specimen = this.store.state.specimens[specimenId];
    if (!specimen) fail("not_found", "标本不存在", 404);
    const balance = computeBalance(this.store.state, specimenId);
    const apps = Object.values(this.store.state.applications)
      .filter((a) => a.specimenId === specimenId)
      .map((a) => ({
        applicationId: a.id,
        applicantId: a.applicantId,
        state: a.state,
        currentVersionNo: a.currentVersionNo,
        versions: a.versions.map((v) => ({
          versionNo: v.versionNo,
          ruleVersion: v.ruleVersion,
          reviewMode: v.reviewMode,
          zoneId: v.zoneId,
          plannedMassMg: v.plannedMassMg,
          method: v.method,
          superseded: v.superseded,
          createdAt: v.createdAt,
        })),
        decisions: a.decisions,
        cuttings: a.cuttings,
        deviations: a.deviations,
        result: a.result
          ? { ...a.result, state: this.resultStateAt(a, now) }
          : null,
        terminalReason: a.terminalReason,
        events: a.events,
      }));
    return {
      specimen,
      balance,
      currentRuleVersion: this.store.state.currentRuleVersion,
      applications: apps,
      generatedAt: iso(now),
    };
  }

  /** 管理员：全部申请（列表）。 */
  listApplications(): Application[] {
    return Object.values(this.store.state.applications);
  }

  /** 申请人：本人全部申请及补件项概览。 */
  myApplications(actorId: string): ApplicantView[] {
    return Object.values(this.store.state.applications)
      .filter((a) => a.applicantId === actorId)
      .map((a) => this.applicantView(a.id, actorId));
  }

  resultStateAt(app: Application, now: Date): ResultState {
    if (!app.result) return "not_due";
    if (app.result.receivedAt) return "received";
    if (!app.result.dueAt) return "not_due";
    const due = new Date(app.result.dueAt);
    if (now.getTime() > due.getTime()) return "overdue";
    if (now.getTime() >= addDays(due, -7).getTime()) return "due";
    return "not_due";
  }

  /** 管理员对超差记录追加处置说明（不改变批准结论与余量）。 */
  annotateDeviation(
    applicationId: string,
    deviationId: string,
    actorId: string,
    note: string,
  ): Promise<DeviationRecord> {
    return this.mutateApp(applicationId, actorId, (app, actor) => {
      if (actor.role !== "admin") fail("forbidden", "仅管理员可标注偏差处置", 403);
      const d = app.deviations.find((x) => x.id === deviationId);
      if (!d) fail("not_found", "偏差记录不存在", 404);
      if (!note.trim()) fail("validation_error", "处置说明不能为空");
      d.note = note;
      return d;
    });
  }

  // ---------------- 内部 ----------------

  private mutateApp<T>(
    applicationId: string,
    actorId: string,
    job: (app: Application, actor: User) => T,
  ): Promise<T> {
    return this.store.mutate(() => {
      const app = this.requireApp(applicationId);
      const actor = this.store.state.users[actorId];
      if (!actor) fail("not_found", "用户不存在", 404);
      return job(app, actor);
    });
  }

  private requireApp(applicationId: string): Application {
    const app = this.store.state.applications[applicationId];
    if (!app) fail("not_found", "申请不存在", 404);
    return app!;
  }

  private currentVersion(app: Application): ApplicationVersion {
    const v = app.versions.find((x) => x.versionNo === app.currentVersionNo);
    if (!v) throw new DomainError("conflict", "当前版本缺失");
    return v;
  }

  private buildVersion(versionNo: number, input: ApplicationInput, now: Date, superseded: boolean): ApplicationVersion {
    const specimen = this.store.state.specimens[input.specimenId]!;
    const zone = specimen.zones.find((z) => z.id === input.zoneId)!;
    return {
      versionNo,
      ruleVersion: latestRuleVersion(),
      purpose: input.purpose,
      zoneId: input.zoneId,
      plannedMassMg: input.plannedMassMg,
      method: input.method,
      resultPromise: { deliverable: input.deliverable, dueDays: input.resultDueDays },
      confidentialityMonths: input.confidentialityMonths,
      reviewMode: resolveReviewMode(input.plannedMassMg, !zone.reinforced),
      createdAt: iso(now),
      superseded,
    };
  }

  private versionToInput(app: Application, v: ApplicationVersion): ApplicationInput {
    return {
      applicantId: app.applicantId,
      specimenId: app.specimenId,
      purpose: v.purpose,
      zoneId: v.zoneId,
      plannedMassMg: v.plannedMassMg,
      method: v.method,
      deliverable: v.resultPromise.deliverable,
      resultDueDays: v.resultPromise.dueDays,
      confidentialityMonths: v.confidentialityMonths,
    };
  }

  private validateInput(input: ApplicationInput): void {
    if (!input.purpose?.trim()) fail("validation_error", "研究目的不能为空");
    if (!input.deliverable?.trim()) fail("validation_error", "成果返还承诺不能为空");
    if (!isFinitePositiveNumber(input.plannedMassMg)) fail("validation_error", "预计质量必须为正数");
    if (!isFinitePositiveNumber(input.resultDueDays)) fail("validation_error", "成果返还期限(天)必须为正数");
    if (typeof input.confidentialityMonths !== "number" || input.confidentialityMonths < 0) {
      fail("validation_error", "保密期限(月)不能为负");
    }
    if (!["surface_swab", "micro_drill", "section", "powder"].includes(input.method)) {
      fail("validation_error", `未知检测方法: ${String(input.method)}`);
    }
  }

  /** 额度校验 + 路由；无法形成法定人数时挂起且不预占。 */
  private routeIntoReview(app: Application, v: ApplicationVersion, now: Date, resubmit = false): void {
    const state = this.store.state;
    const specimen = state.specimens[app.specimenId]!;
    const zone = specimen.zones.find((z) => z.id === v.zoneId)!;
    const rule = getRule(v.ruleVersion);
    // 排除自身：改版本重新路由时，旧预占不能算作他人占用。
    const balance = computeBalance(state, app.specimenId, app.id);
    const zb = balance.zones.find((x) => x.zoneId === v.zoneId)!;
    const availableForCheck = balance.availableMg;
    const zoneAvailableForCheck = zb.availableMg;

    if (v.plannedMassMg > zoneAvailableForCheck + 1e-6) {
      fail("quota_exceeded", "申请质量超过该取样区可用余量", 409, {
        requested: v.plannedMassMg,
        zoneAvailable: round3(zoneAvailableForCheck),
      });
    }
    const ratio = v.plannedMassMg / availableForCheck;
    if (ratio > rule.maxQuotaRatioOfAvailable + 1e-9) {
      fail("quota_exceeded", `单次申请不得超过标本可用余量的 ${rule.maxQuotaRatioOfAvailable * 100}%`, 409, {
        requested: v.plannedMassMg,
        available: round3(availableForCheck),
        ratio: round3(ratio),
      });
    }
    if (!zone.reinforced) {
      if (ratio > rule.maxQuotaRatioUnreinforced + 1e-9) {
        fail("quota_exceeded", `未加固区申请不得超过可用余量的 ${rule.maxQuotaRatioUnreinforced * 100}%`, 409, {
          requested: v.plannedMassMg,
          available: round3(availableForCheck),
        });
      }
      if (rule.methodDestructiveness[v.method] > rule.maxDestructivenessUnreinforced) {
        this.systemReject(app, v, "method_too_destructive",
          `检测方法 ${v.method} 对未加固区破坏性等级 ${rule.methodDestructiveness[v.method]} 超过上限 ${rule.maxDestructivenessUnreinforced}`, now);
        return;
      }
    }

    const reviewers = Object.values(state.users).filter((u) => u.role === "reviewer");
    const eligible = reviewers.filter((u) => !mustRecuse(state, u, app).recuse);

    if (v.reviewMode === "single") {
      const assignee = eligible[0];
      if (!assignee) {
        this.block(app, "没有可用（无需回避）的评审委员", now, { eligible: [] });
        return;
      }
      this.openSteps(app, v, [assignee.id], null, rule, now);
    } else {
      if (eligible.length < rule.committeeSize) {
        this.block(
          app,
          `委员会需要 ${rule.committeeSize} 名无需回避的委员，当前仅 ${eligible.length} 名`,
          now,
          { eligible: eligible.map((u) => u.id) },
        );
        return;
      }
      const director = Object.values(state.users).find(
        (u) => u.role === "director" && !mustRecuse(state, u, app).recuse,
      );
      if (!director) {
        this.block(app, "没有可用（无需回避）的主管主任", now, {});
        return;
      }
      // 固定取前 N 名，保证路由可重现。
      this.openSteps(
        app,
        v,
        eligible.slice(0, rule.committeeSize).map((u) => u.id),
        director.id,
        rule,
        now,
      );
    }

    if (!resubmit) app.submittedAt = iso(now);
    app.state = "reviewing";
    app.blockedReason = null;
    app.reviewDeadline = iso(addHours(now, rule.reviewTimeoutHours));
    this.pushEvent(app, resubmit ? "rerouted" : "submitted", app.applicantId, {
      versionNo: v.versionNo,
      reviewMode: v.reviewMode,
      ruleVersion: v.ruleVersion,
    }, now);
  }

  private block(
    app: Application,
    reason: string,
    now: Date,
    detail: Record<string, unknown>,
  ): void {
    // 无法形成法定人数：挂起为 submitted，不开放步骤、不预占额度。
    app.state = "submitted";
    app.blockedReason = reason;
    app.reviewDeadline = null;
    app.submittedAt = app.submittedAt ?? iso(now);
    this.pushEvent(app, "routing_blocked", "system", { reason, ...detail }, now);
  }

  private openSteps(
    app: Application,
    v: ApplicationVersion,
    reviewerIds: string[],
    directorId: string | null,
    rule: RuleSet,
    now: Date,
  ): void {
    let stepNo = app.steps.reduce((m, s) => Math.max(m, s.stepNo), 0) + 1;
    for (const id of reviewerIds) {
      const step: ReviewStep = {
        id: newId("stp"),
        versionNo: v.versionNo,
        stepNo: stepNo++,
        kind: "reviewer",
        assigneeId: id,
        status: "pending",
        ruleVersion: rule.version,
        openedAt: iso(now),
        decidedAt: null,
      };
      app.steps.push(step);
    }
    if (directorId) {
      app.steps.push({
        id: newId("stp"),
        versionNo: v.versionNo,
        stepNo,
        kind: "director",
        assigneeId: directorId,
        status: "pending",
        ruleVersion: rule.version,
        openedAt: iso(now),
        decidedAt: null,
      });
    }
  }

  private requireOpenStep(app: Application, actorId: string): ReviewStep {
    const step = app.steps.find(
      (s) =>
        s.versionNo === app.currentVersionNo &&
        s.assigneeId === actorId &&
        (s.status === "pending" || s.status === "waiting_supplement"),
    );
    if (!step) fail("conflict", "没有分配给您的在办步骤，或版本已更新", 409);
    return step!;
  }

  /** 统一计票：全票制任一反对即否决；多数制过半即出结果；否则待定。 */
  private committeeOutcome(
    app: Application,
    versionNo: number,
  ): "approved" | "rejected" | "pending" {
    const v = app.versions.find((x) => x.versionNo === versionNo)!;
    const steps = app.steps.filter((s) => s.versionNo === versionNo && s.kind === "reviewer");
    const approves = steps.filter((s) => s.status === "approved").length;
    const rejects = steps.filter((s) => s.status === "rejected").length;
    if (v.reviewMode === "single" || v.reviewMode === "committee_unanimous") {
      if (rejects >= 1) return "rejected";
      if (approves === steps.length) return "approved";
      return "pending";
    }
    if (approves > steps.length / 2) return "approved";
    const remaining = steps.length - approves - rejects;
    if (rejects > steps.length / 2 || approves + remaining <= steps.length / 2) {
      return "rejected";
    }
    return "pending";
  }

  private finalizeApproval(app: Application, now: Date): void {
    if (app.state === "approved") return;
    this.closeOpenSteps(app, now);
    app.state = "approved";
    app.finalizedAt = iso(now);
    app.terminalReason = "approved";
    app.reviewDeadline = null;
    this.pushEvent(app, "approved", "system", { versionNo: app.currentVersionNo }, now);
  }

  private finalizeRejection(app: Application, actorId: string, reason: string, now: Date): void {
    this.closeOpenSteps(app, now);
    app.state = "rejected";
    app.finalizedAt = iso(now);
    app.terminalReason = reason;
    app.reviewDeadline = null;
    this.pushEvent(app, "rejected", actorId, { reason }, now);
  }

  private systemReject(app: Application, v: ApplicationVersion, reason: string, message: string, now: Date): void {
    app.decisions.push({
      id: newId("dec"),
      versionNo: v.versionNo,
      stepNo: null,
      actorId: "system",
      actorKind: "system",
      vote: "reject",
      comment: message,
      ruleVersion: v.ruleVersion,
      reason,
      at: iso(now),
    });
    this.closeOpenSteps(app, now);
    app.state = "rejected";
    app.finalizedAt = iso(now);
    app.terminalReason = reason;
    app.reviewDeadline = null;
    this.pushEvent(app, "rejected", "system", { reason, message }, now);
  }

  private expireOne(app: Application, now: Date): void {
    this.closeOpenSteps(app, now);
    const v = this.currentVersion(app);
    const deadline = app.reviewDeadline;
    app.decisions.push({
      id: newId("dec"),
      versionNo: v.versionNo,
      stepNo: null,
      actorId: "system",
      actorKind: "system",
      vote: "reject",
      comment: `评审超过 ${getRule(v.ruleVersion).reviewTimeoutHours} 小时未完成，预占额度自动释放`,
      ruleVersion: v.ruleVersion,
      reason: "review_timeout",
      at: iso(now),
    });
    app.state = "rejected";
    app.finalizedAt = iso(now);
    app.terminalReason = "review_timeout";
    app.reviewDeadline = null;
    this.pushEvent(app, "review_timed_out", "system", { deadline }, now);
  }

  private closeOpenSteps(app: Application, now: Date): void {
    for (const s of app.steps) {
      if (s.versionNo === app.currentVersionNo && (s.status === "pending" || s.status === "waiting_supplement")) {
        s.status = "closed";
        s.decidedAt = iso(now);
      }
    }
  }

  private pushEvent(app: Application, type: string, actorId: string, detail: unknown, now: Date): void {
    app.events.push({
      seq: app.events.length + 1,
      at: iso(now),
      type,
      actorId,
      detail,
    } satisfies ApplicationEvent);
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
