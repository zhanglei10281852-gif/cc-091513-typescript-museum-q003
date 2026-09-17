import assert from "node:assert/strict";
import { test } from "node:test";

import { DecisionService } from "../src/domain/decision.js";
import { QueryService } from "../src/domain/views.js";
import { DomainStore } from "../src/domain/store.js";
import type { Actor, ApplicationDraft, SamplingMethod } from "../src/domain/types.js";
import { DomainError } from "../src/domain/errors.js";

import type { FakeClock } from "./clock-fixture.js";
import { fakeClock, iso, plusDays } from "./clock-fixture.js";

const admin: Actor = { userId: "admin", roles: ["admin"] };
const staff: Actor = { userId: "admin", roles: ["admin", "reviewer"] };

function applicant(id: string, org: string): Actor {
  return { userId: id, roles: ["researcher"] };
}
function reviewer(id: string): Actor {
  return { userId: id, roles: ["reviewer"] };
}

function draft(overrides: Partial<ApplicationDraft> = {}): ApplicationDraft {
  return {
    purpose: "微结构无损比对研究",
    zoneId: "Z-UNREINFORCED",
    locationNotes: "标本腹侧未加固表层第 3 节",
    estimatedMassMg: 300,
    method: "micro_drill",
    deliverables: ["检测原始数据", "剩余粉末返还"],
    resultReturnBy: iso(plusDays(new Date("2026-09-01T00:00:00.000Z"), 60)),
    confidentialityMonths: 12,
    ...overrides,
  };
}

async function seedWorld(clock: FakeClock) {
  const store = new DomainStore(clock);
  const decisions = new DecisionService(store, clock);
  const queries = new QueryService(() => store.snapshot(), clock);

  await decisions.createSpecimen(admin, {
    id: "SPM1",
    code: "PAL-001",
    name: "稀有模式标本",
    zones: [
      { id: "Z-REIN", name: "已加固区", reinforced: true, initialMassMg: 2000 },
      { id: "Z-UNREINFORCED", name: "仅存未加固区", reinforced: false, initialMassMg: 800 },
    ],
  });

  // 4 名普通委员 + 1 名主任；前两位与古甲大学同单位，主任额外把古甲大学列入回避单位。
  const roster: Array<[string, string | undefined, boolean, string[], string[]]> = [
    ["rv-li", "ORG-GJD", false, [], []],
    ["rv-wang", "ORG-GJD", false, [], []],
    ["rv-chen", "ORG-DC", false, [], []],
    ["rv-zhao", "ORG-XSD", false, [], []],
    ["rv-sun", undefined, true, [], ["ORG-GJD"]],
  ];
  for (const [id, orgId, isDirector, conflictUserIds, conflictOrgIds] of roster) {
    await decisions.upsertReviewer(admin, {
      id,
      name: id,
      ...(orgId ? { orgId } : {}),
      isDirector,
      conflictUserIds,
      conflictOrgIds,
    });
  }
  return { store, decisions, queries };
}

async function createAndSubmit(
  decisions: DecisionService,
  actor: Actor,
  org: string,
  overrides: Partial<ApplicationDraft> = {},
) {
  const created = await decisions.createApplication(actor, {
    specimenId: "SPM1",
    applicantOrgId: org,
    draft: draft(overrides),
  });
  const submitted = await decisions.submitApplication(actor, created.id);
  return { id: created.id, submitted };
}

// ---------- 测试 ----------

test("并发送审不能预占同一份材料：第二个申请被 409 拒绝", async () => {
  const clock = fakeClock();
  const { decisions, queries } = await seedWorld(clock);
  const a = applicant("u-a", "ORG-AAA");
  const b = applicant("u-b", "ORG-BBB");

  // 未加固区 800mg，两份各要 500mg。
  const first = await createAndSubmit(decisions, a, "ORG-AAA", { estimatedMassMg: 500 });
  assert.equal(first.submitted.application.state, "reviewing");

  await assert.rejects(
    () => createAndSubmit(decisions, b, "ORG-BBB", { estimatedMassMg: 500 }),
    (error: unknown) => error instanceof DomainError && error.code === "material_unavailable",
  );

  const trace = queries.adminTrace("SPM1");
  const zone = trace.specimens[0]!.zones.find((item) => item.zoneId === "Z-UNREINFORCED")!;
  assert.equal(zone.heldMassMg, 500);
  assert.equal(zone.freeForReservationMg, 300);
});

test("互斥区在并发提交下成立：只有一份预占成功", async () => {
  const clock = fakeClock();
  const { decisions } = await seedWorld(clock);

  // 各建 3 份 300mg 草稿（300*2=600<800，300*3>800）。
  const actors = [applicant("p1", "ORG-1"), applicant("p2", "ORG-2"), applicant("p3", "ORG-3")];
  const drafts = await Promise.all(
    actors.map((actor, i) =>
      decisions.createApplication(actor, { specimenId: "SPM1", applicantOrgId: `ORG-${i}`, draft: draft() }),
    ),
  );
  const results = await Promise.allSettled(
    drafts.map((item, i) => decisions.submitApplication(actors[i]!, item.id)),
  );
  const fulfilled = results.filter((item) => item.status === "fulfilled");
  const rejected = results.filter((item) => item.status === "rejected");
  assert.equal(fulfilled.length, 2);
  assert.equal(rejected.length, 1);
});

test("撤回后释放预留，材料可被后续申请预占", async () => {
  const clock = fakeClock();
  const { decisions, queries } = await seedWorld(clock);
  const a = applicant("u-a", "ORG-AAA");
  const b = applicant("u-b", "ORG-BBB");

  const first = await createAndSubmit(decisions, a, "ORG-AAA", { estimatedMassMg: 500 });
  await assert.rejects(() => createAndSubmit(decisions, b, "ORG-BBB", { estimatedMassMg: 500 }));

  await decisions.withdrawApplication(a, first.id);
  const second = await createAndSubmit(decisions, b, "ORG-BBB", { estimatedMassMg: 500 });
  assert.equal(second.submitted.application.state, "reviewing");

  const trace = queries.adminTrace("SPM1");
  const zone = trace.specimens[0]!.zones.find((item) => item.zoneId === "Z-UNREINFORCED")!;
  assert.equal(zone.heldMassMg, 500);
  const holds = zone.holds;
  assert.equal(holds.find((h) => h.status === "released")!.releaseReason, "withdrawn");
});

test("送审后修改关键参数产生新版本并释放旧预留", async () => {
  const clock = fakeClock();
  const { decisions, queries } = await seedWorld(clock);
  const a = applicant("u-a", "ORG-AAA");

  const created = await decisions.createApplication(a, {
    specimenId: "SPM1",
    applicantOrgId: "ORG-AAA",
    draft: draft({ estimatedMassMg: 300 }),
  });
  await decisions.submitApplication(a, created.id);

  const revision = await decisions.reviseApplication(a, created.id, draft({ estimatedMassMg: 200, method: "powder" }));
  assert.equal(revision.newVersion, true);
  assert.equal(revision.application.currentVersionNo, 2);
  assert.equal(revision.application.state, "draft");
  const oldVersion = revision.application.versions[0]!;
  assert.equal(oldVersion.decision, "superseded");

  // 旧预留已释放，新版本尚未送审不占材料。
  const trace = queries.adminTrace("SPM1");
  const zone = trace.specimens[0]!.zones.find((item) => item.zoneId === "Z-UNREINFORCED")!;
  assert.equal(zone.heldMassMg, 0);

  await decisions.submitApplication(a, created.id);
  const after = queries.adminTrace("SPM1");
  const zoneAfter = after.specimens[0]!.zones.find((item) => item.zoneId === "Z-UNREINFORCED")!;
  assert.equal(zoneAfter.heldMassMg, 200);
});

test("送审前修改就地更新草稿，不产生新版本", async () => {
  const clock = fakeClock();
  const { decisions } = await seedWorld(clock);
  const a = applicant("u-a", "ORG-AAA");
  const created = await decisions.createApplication(a, {
    specimenId: "SPM1",
    applicantOrgId: "ORG-AAA",
    draft: draft({ estimatedMassMg: 300 }),
  });
  const revision = await decisions.reviseApplication(a, created.id, draft({ estimatedMassMg: 250 }));
  assert.equal(revision.newVersion, false);
  assert.equal(revision.application.versions.length, 1);
  assert.equal(revision.application.versions[0]!.estimatedMassMg, 250);
});

test("回避关系过滤委员：古甲大学申请导致委员会不足，路径阻塞且不预占", async () => {
  const clock = fakeClock();
  const { decisions, queries } = await seedWorld(clock);
  const gjd = applicant("u-gjd", "ORG-GJD");

  // 未加固区必上委员会；李、王（同单位）与孙主任（冲突单位）均回避，只剩陈、赵 2 人。
  const created = await decisions.createApplication(gjd, {
    specimenId: "SPM1",
    applicantOrgId: "ORG-GJD",
    draft: draft(),
  });
  const submitted = await decisions.submitApplication(gjd, created.id);
  assert.equal(submitted.reviewPath.status, "blocked_recusal");
  assert.equal(submitted.application.state, "submitted");
  assert.equal(submitted.hold, undefined);

  // 增补一名无关联委员后重建路径，补做预留。
  await decisions.upsertReviewer(admin, {
    id: "rv-zhou",
    name: "周委员",
    orgId: "ORG-OTH",
    isDirector: false,
    conflictUserIds: [],
    conflictOrgIds: [],
  });
  const path = await decisions.regeneratePath(admin, created.id);
  assert.equal(path.status, "active");
  const committee = path.stages[0]!;
  assert.deepEqual(committee.pool.sort(), ["rv-chen", "rv-zhao", "rv-zhou"]);

  // 被回避委员不能投票。
  await assert.rejects(
    () => decisions.castVote(reviewer("rv-li"), created.id, "approve"),
    (error: unknown) => error instanceof DomainError && error.statusCode === 403,
  );

  const queue = queries.reviewerQueue(reviewer("rv-li")).queue;
  assert.equal(queue.find((item) => item.application.id === created.id)?.recused, true);
});

test("委员会三票两赞通过；再取样将跌破安全库存时追加主任签批", async () => {
  const clock = fakeClock();
  const { decisions, queries } = await seedWorld(clock);
  const a = applicant("u-a", "ORG-AAA");

  // 700mg：未加固区上委员会，取后仅余 100 < 200 安全库存 → 主任签批。
  const { id } = await createAndSubmit(decisions, a, "ORG-AAA", { estimatedMassMg: 700 });
  const detail = queries.applicationDetail(a, id);
  assert.deepEqual(
    detail.progress.map((stage) => stage.name),
    ["committee_review", "director_signoff"],
  );

  await decisions.castVote(reviewer("rv-chen"), id, "approve");
  await decisions.castVote(reviewer("rv-li"), id, "reject");
  // 两票未满 3，主任此时不能提前签批。
  await assert.rejects(() => decisions.castVote(reviewer("rv-sun"), id, "approve"));
  await decisions.castVote(reviewer("rv-zhao"), id, "approve");

  const pending = queries.applicationDetail(staff, id);
  assert.equal(pending.application.state, "reviewing");
  assert.equal(pending.progress.find((s) => s.name === "director_signoff")!.current, true);

  await decisions.castVote(reviewer("rv-sun"), id, "approve");
  const approved = queries.applicationDetail(a, id).application;
  assert.equal(approved.state, "approved");
  const record = approved.versions.at(-1)!.decisionRecord!;
  assert.equal(record.kind, "approved");
  assert.equal(record.ruleVersion, "1.0.0");
  assert.ok(record.approvalNo!.startsWith("APV-2026-"));
});

test("委员会拒绝时释放预留，且结论不可修改", async () => {
  const clock = fakeClock();
  const { decisions, queries } = await seedWorld(clock);
  const a = applicant("u-a", "ORG-AAA");
  const { id } = await createAndSubmit(decisions, a, "ORG-AAA");

  await decisions.castVote(reviewer("rv-chen"), id, "reject");
  await decisions.castVote(reviewer("rv-li"), id, "reject");
  await decisions.castVote(reviewer("rv-zhao"), id, "reject");

  const rejected = queries.applicationDetail(a, id).application;
  assert.equal(rejected.state, "rejected");
  const trace = queries.adminTrace("SPM1");
  const zone = trace.specimens[0]!.zones.find((item) => item.zoneId === "Z-UNREINFORCED")!;
  assert.equal(zone.heldMassMg, 0);
  assert.equal(zone.holds[0]!.releaseReason, "committee_vote");

  await assert.rejects(() => decisions.castVote(reviewer("rv-sun"), id, "approve"));
  await assert.rejects(() =>
    decisions.reviseApplication(a, id, draft()),
  );
});

test("审批超时自动拒绝并释放预留", async () => {
  const clock = fakeClock();
  const { decisions, queries } = await seedWorld(clock);
  const a = applicant("u-a", "ORG-AAA");
  const { id } = await createAndSubmit(decisions, a, "ORG-AAA");

  clock.advanceDays(15);
  const sweep = await decisions.sweepTimeouts(staff);
  assert.deepEqual(sweep.timedOut, [id]);

  const rejected = queries.applicationDetail(a, id).application;
  assert.equal(rejected.state, "rejected");
  assert.equal(rejected.versions[0]!.decision, "timeout");
  const trace = queries.adminTrace("SPM1");
  const zone = trace.specimens[0]!.zones.find((item) => item.zoneId === "Z-UNREINFORCED")!;
  assert.equal(zone.heldMassMg, 0);
  assert.equal(zone.holds[0]!.releaseReason, "review_timeout");
});

test("补件流程：研究员看到 open 补件项，回应后评审继续", async () => {
  const clock = fakeClock();
  const { decisions, queries } = await seedWorld(clock);
  const a = applicant("u-a", "ORG-AAA");
  // 已加固区小质量件走独任初审。
  const created = await decisions.createApplication(a, {
    specimenId: "SPM1",
    applicantOrgId: "ORG-AAA",
    draft: draft({ zoneId: "Z-REIN", estimatedMassMg: 100 }),
  });
  await decisions.submitApplication(a, created.id);

  const queue = queries.reviewerQueue(reviewer("rv-chen")).queue;
  assert.equal(queue.some((item) => item.application.id === created.id), true);

  await decisions.castVote(reviewer("rv-chen"), created.id, "request_changes", {
    supplementField: "purpose",
    supplementNote: "请补充与既有研究的对照说明",
  });

  const dashboard = queries.researcherDashboard(a);
  const item = dashboard.applications[0]!.openSupplements[0]!;
  assert.equal(item.field, "purpose");

  // 补件未回应前不能推进表决。
  await assert.rejects(() => decisions.castVote(reviewer("rv-chen"), created.id, "approve"));

  await decisions.submitSupplement(a, created.id, item.id, "已补充对照章节 v2");
  await decisions.castVote(reviewer("rv-chen"), created.id, "approve");
  const approved = queries.applicationDetail(a, created.id).application;
  assert.equal(approved.state, "approved");
  assert.equal(approved.supplements[0]!.status, "accepted");
});

test("实际取样偏差追加记录并重算余量，批准结论保持不变", async () => {
  const clock = fakeClock();
  const { decisions, queries } = await seedWorld(clock);
  const a = applicant("u-a", "ORG-AAA");
  const { id } = await createAndSubmit(decisions, a, "ORG-AAA", {
    zoneId: "Z-REIN",
    estimatedMassMg: 500,
  });
  // 已加固区独任审查，按 id 排序首位非主任委员为 rv-chen。
  await decisions.castVote(reviewer("rv-chen"), id, "approve");

  // 实际取 560mg（+12%，超出 10% 容忍）。
  const cutting = await decisions.recordCutting(admin, id, {
    actualMassMg: 560,
    actualMethod: "micro_drill",
  });
  assert.equal(cutting.variance.deltaMg, 60);
  assert.equal(cutting.variance.withinTolerance, false);
  assert.equal(cutting.variance.ruleVersion, "1.0.0");

  const trace = queries.adminTrace("SPM1");
  const zone = trace.specimens[0]!.zones.find((item) => item.zoneId === "Z-REIN")!;
  assert.equal(zone.consumedMassMg, 560);
  assert.equal(zone.availableMassMg, 1440);
  assert.equal(zone.heldMassMg, 0);

  const appTrace = trace.applications.find((item) => item.requestId === id)!;
  const decisionRecord = appTrace.versions[0]!.decisionRecord!;
  assert.equal(decisionRecord.approvedMassMg, 500); // 批准量未被偏差改写

  // 不能重复登记；偏差记录是追加式的。
  await assert.rejects(
    () => decisions.recordCutting(admin, id, { actualMassMg: 10, actualMethod: "powder" }),
    (error: unknown) => error instanceof DomainError && error.code === "cutting_exists",
  );
});

test("实际取样不能超过分区实物余量（即便批准量本身可行）", async () => {
  const clock = fakeClock();
  const { decisions } = await seedWorld(clock);
  const a = applicant("u-a", "ORG-AAA");
  const { id } = await createAndSubmit(decisions, a, "ORG-AAA", {
    zoneId: "Z-REIN",
    estimatedMassMg: 100,
  });
  await decisions.castVote(reviewer("rv-chen"), id, "approve");
  await assert.rejects(
    () => decisions.recordCutting(admin, id, { actualMassMg: 5000, actualMethod: "section" }),
    (error: unknown) => error instanceof DomainError && error.code === "physical_material_exceeded",
  );
});

test("成果到期状态随时间派生，接收后关闭", async () => {
  const clock = fakeClock();
  const { decisions, queries } = await seedWorld(clock);
  const a = applicant("u-a", "ORG-AAA");
  const due = iso(plusDays(clock.current, 30));
  const { id } = await createAndSubmit(decisions, a, "ORG-AAA", {
    zoneId: "Z-REIN",
    estimatedMassMg: 100,
    resultReturnBy: due,
  });
  await decisions.castVote(reviewer("rv-chen"), id, "approve");
  assert.equal(queries.applicationDetail(a, id).effectiveResultState, "not_due");

  clock.advanceDays(25);
  assert.equal(queries.applicationDetail(a, id).effectiveResultState, "due");

  clock.advanceDays(10);
  const refresh = await decisions.refreshResultStates(staff);
  assert.deepEqual(refresh.overdue, [id]);

  await decisions.confirmResultReceived(admin, id, "数据与余样已签收");
  assert.equal(queries.applicationDetail(a, id).effectiveResultState, "received");
});

test("批准逾期未取样只释放预留，批准结论保留但不可再取样", async () => {
  const clock = fakeClock();
  const { decisions, queries } = await seedWorld(clock);
  const a = applicant("u-a", "ORG-AAA");
  const { id } = await createAndSubmit(decisions, a, "ORG-AAA", {
    zoneId: "Z-REIN",
    estimatedMassMg: 100,
  });
  await decisions.castVote(reviewer("rv-chen"), id, "approve");

  clock.advanceDays(91);
  const sweep = await decisions.sweepTimeouts(staff);
  assert.deepEqual(sweep.approvalExpired, [id]);
  const app = queries.applicationDetail(a, id).application;
  assert.equal(app.state, "approved"); // 结论保留
  await assert.rejects(
    () => decisions.recordCutting(admin, id, { actualMassMg: 100, actualMethod: "micro_drill" }),
    (error: unknown) => error instanceof DomainError && error.code === "approval_expired",
  );
});

test("权限：研究员只能查看与操作本人申请", async () => {
  const clock = fakeClock();
  const { decisions, queries } = await seedWorld(clock);
  const a = applicant("u-a", "ORG-AAA");
  const b = applicant("u-b", "ORG-BBB");
  const { id } = await createAndSubmit(decisions, a, "ORG-AAA");

  assert.throws(() => queries.applicationDetail(b, id), (error: unknown) => error instanceof DomainError && error.statusCode === 403);
  await assert.rejects(() => decisions.withdrawApplication(b, id));
  assert.equal(queries.researcherDashboard(b).applications.length, 0);
});

test("管理员追溯包含规则版本、历次版本、切割与成果", async () => {
  const clock = fakeClock();
  const { decisions, queries } = await seedWorld(clock);
  const a = applicant("u-a", "ORG-AAA");
  const created = await decisions.createApplication(a, {
    specimenId: "SPM1",
    applicantOrgId: "ORG-AAA",
    draft: draft({ zoneId: "Z-REIN", estimatedMassMg: 100 }),
  });
  await decisions.submitApplication(a, created.id);
  // 送审后修订产生 v2，再走完批准与切割。
  await decisions.reviseApplication(a, created.id, draft({ zoneId: "Z-REIN", estimatedMassMg: 120 }));
  await decisions.submitApplication(a, created.id);
  await decisions.castVote(reviewer("rv-chen"), created.id, "approve");
  await decisions.recordCutting(admin, created.id, { actualMassMg: 118, actualMethod: "micro_drill" });

  const trace = queries.adminTrace("SPM1");
  assert.equal(trace.ruleVersion, "1.0.0");
  const app = trace.applications[0]!;
  assert.equal(app.versions.length, 2);
  assert.equal(app.versions[0]!.decision, "superseded");
  assert.equal(app.versions[1]!.decisionRecord!.approvedMassMg, 120);
  assert.equal(app.versions[1]!.keyParams.estimatedMassMg, 120);
  assert.equal(trace.specimens[0]!.zones.find((z) => z.zoneId === "Z-REIN")!.cuttings.length, 1);
  assert.equal(app.result!.state, "not_due");
});
