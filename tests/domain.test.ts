import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SamplingService } from "../src/domain/service.js";
import { Store } from "../src/domain/store.js";
import { computeBalance } from "../src/domain/quota.js";
import { RULES_2026_09_V1 } from "../src/domain/rules.js";
import type { DataState, User } from "../src/domain/types.js";

function makeState(): DataState {
  const users: Record<string, User> = {
    u_admin: { id: "u_admin", name: "主管", role: "admin", institutionId: null },
    u_dir: { id: "u_dir", name: "陈主任", role: "director", institutionId: "inst_nsm" },
    u_rev_li: { id: "u_rev_li", name: "李(A校)", role: "reviewer", institutionId: "inst_a" },
    u_rev_wang: { id: "u_rev_wang", name: "王(B校)", role: "reviewer", institutionId: "inst_b" },
    u_rev_zhao: { id: "u_rev_zhao", name: "赵(C校)", role: "reviewer", institutionId: "inst_c" },
    u_rev_sun: { id: "u_rev_sun", name: "孙(馆方)", role: "reviewer", institutionId: "inst_nsm" },
    u_app_zhou: { id: "u_app_zhou", name: "周(A校)", role: "applicant", institutionId: "inst_a" },
    u_app_wu: { id: "u_app_wu", name: "吴(B校)", role: "applicant", institutionId: "inst_b" },
    u_app_zheng: { id: "u_app_zheng", name: "郑(C校)", role: "applicant", institutionId: "inst_c" },
  };
  return {
    seq: 0,
    currentRuleVersion: RULES_2026_09_V1.version,
    users,
    specimens: {
      spm1: {
        id: "spm1",
        name: "稀有化石",
        initialMassMg: 10000,
        zones: [
          { id: "z_safe", name: "加固区", reinforced: true, initialMassMg: 8000 },
          { id: "z_raw", name: "仅存未加固区", reinforced: false, initialMassMg: 2000 },
        ],
        createdAt: "2026-09-01T00:00:00.000Z",
      },
    },
    recusals: [
      {
        id: "rec1",
        reviewerId: "u_rev_sun",
        applicantId: null,
        institutionId: "inst_b",
        reason: "与 B 校有合作",
        createdAt: "2026-09-02T00:00:00.000Z",
      },
    ],
    applications: {},
  };
}

let counter = 0;
async function makeService(): Promise<SamplingService> {
  counter += 1;
  const file = join(tmpdir(), `sampling-test-${process.pid}-${counter}-${Date.now()}.json`);
  const store = new Store(makeState(), file);
  return new SamplingService(store);
}

const baseInput = {
  applicantId: "u_app_zhou",
  specimenId: "spm1",
  purpose: "古组织学研究",
  zoneId: "z_raw",
  plannedMassMg: 200,
  method: "powder" as const,
  deliverable: "原始数据与报告",
  resultDueDays: 90,
  confidentialityMonths: 12,
};

async function submittedRawApp(svc: SamplingService, overrides = {}) {
  const app = await svc.createApplication({ ...baseInput, ...overrides });
  await svc.submit(app.id, "u_app_zhou");
  return svc.listApplications().find((a) => a.id === app.id)!;
}

test("未加固区申请走全票委员会，同校委员自动回避、显式回避生效", async () => {
  const svc = await makeService();
  const app = await submittedRawApp(svc);
  const v = app.versions[0]!;
  assert.equal(v.reviewMode, "committee_unanimous");
  assert.equal(app.state, "reviewing");

  const reviewers = app.steps.filter((s) => s.kind === "reviewer").map((s) => s.assigneeId).sort();
  // 李委员与周研究员同属 A 校，必须回避。
  assert.ok(!reviewers.includes("u_rev_li"));
  assert.deepEqual([...reviewers].sort(), ["u_rev_sun", "u_rev_wang", "u_rev_zhao"]);
  assert.ok(app.steps.some((s) => s.kind === "director"));
});

test("C 校申请人：赵委员同校自动回避，其余三人组成委员会", async () => {
  const svc = await makeService();
  const app = await submittedRawApp(svc, { applicantId: "u_app_zheng" });
  const reviewers = app.steps.filter((s) => s.kind === "reviewer").map((s) => s.assigneeId).sort();
  assert.deepEqual(reviewers, ["u_rev_li", "u_rev_sun", "u_rev_wang"]);
  assert.ok(!reviewers.includes("u_rev_zhao")); // 赵与郑同属 C 校
});

test("B 校申请人：王委员同校加孙委员显式回避，不足三人而挂起且不预占", async () => {
  const svc = await makeService();
  const app = await svc.createApplication({ ...baseInput, applicantId: "u_app_wu", plannedMassMg: 200 });
  await svc.submit(app.id, "u_app_wu");
  const blocked = svc.listApplications().find((a) => a.id === app.id)!;
  assert.equal(blocked.state, "submitted");
  assert.match(blocked.blockedReason ?? "", /委员会需要/);
  const balance = computeBalance((svc as unknown as { store: { state: DataState } }).store.state, "spm1");
  assert.equal(balance.reservedMg, 0);
});

test("未加固区使用高破坏性 section 方法被系统驳回且不预占额度", async () => {
  const svc = await makeService();
  const app = await submittedRawApp(svc, { method: "section", plannedMassMg: 100 });
  assert.equal(app.state, "rejected");
  assert.equal(app.terminalReason, "method_too_destructive");
  const sysDecision = app.decisions.find((d) => d.actorKind === "system")!;
  assert.equal(sysDecision.ruleVersion, RULES_2026_09_V1.version);
  const balance = computeBalance((svc as unknown as { store: { state: DataState } }).store.state, "spm1");
  assert.equal(balance.reservedMg, 0);
  assert.equal(balance.availableMg, 10000);
});

test("未加固区申请超过可用余量 25% 被配额规则拒绝", async () => {
  const svc = await makeService();
  const app = await svc.createApplication({ ...baseInput, plannedMassMg: 2600 });
  await assert.rejects(svc.submit(app.id, "u_app_zhou"), (e: Error & { code?: string }) =>
    e.code === "quota_exceeded",
  );
});

test("送审后即预占；并发申请不能预占同一份未加固材料", async () => {
  const svc = await makeService();
  // A 校申请预占未加固区全部 2000mg（恰为 25% 上限与分区上限）。
  const a = await submittedRawApp(svc, { plannedMassMg: 2000 });
  let balance = computeBalance((svc as unknown as { store: { state: DataState } }).store.state, "spm1");
  assert.equal(balance.reservedMg, 2000);

  // 并发到达的两校申请都必须串行经过同一把锁，不能双重预占。
  const b = await svc.createApplication({ ...baseInput, applicantId: "u_app_wu", plannedMassMg: 100 });
  const c = await svc.createApplication({ ...baseInput, applicantId: "u_app_zheng", plannedMassMg: 100 });
  const results = await Promise.allSettled([
    svc.submit(b.id, "u_app_wu"),
    svc.submit(c.id, "u_app_zheng"),
  ]);
  const failures = results.filter((r) => r.status === "rejected");
  assert.equal(failures.length, 2);
  balance = computeBalance((svc as unknown as { store: { state: DataState } }).store.state, "spm1");
  assert.equal(balance.reservedMg, 2000); // 仍只有 A 的预占
  assert.equal(a.state, "reviewing");
});

test("撤回后预占额度立即释放", async () => {
  const svc = await makeService();
  const app = await submittedRawApp(svc, { plannedMassMg: 1500 });
  let balance = computeBalance((svc as unknown as { store: { state: DataState } }).store.state, "spm1");
  assert.equal(balance.availableMg, 8500);
  await svc.withdraw(app.id, "u_app_zhou");
  balance = computeBalance((svc as unknown as { store: { state: DataState } }).store.state, "spm1");
  assert.equal(balance.availableMg, 10000);
  assert.equal(balance.reservedMg, 0);
});

test("委员会任一委员拒绝即整体驳回并释放额度（全票制）", async () => {
  const svc = await makeService();
  const app = await submittedRawApp(svc, { plannedMassMg: 300 });
  const reviewers = app.steps.filter((s) => s.kind === "reviewer");
  await svc.decide(app.id, reviewers[0]!.assigneeId, "approve", "可以");
  const still = svc.listApplications().find((a) => a.id === app.id)!;
  assert.equal(still.state, "reviewing");
  await svc.decide(app.id, reviewers[1]!.assigneeId, "reject", "风险过大");
  const after = svc.listApplications().find((a) => a.id === app.id)!;
  assert.equal(after.state, "rejected");
  assert.equal(after.terminalReason, "committee_rejected");
  const balance = computeBalance((svc as unknown as { store: { state: DataState } }).store.state, "spm1");
  assert.equal(balance.reservedMg, 0);
});

test("加固区大额申请走多数制+主任：两票赞成即过委员会，主任批准后生效", async () => {
  const svc = await makeService();
  const app = await submittedRawApp(svc, {
    zoneId: "z_safe",
    plannedMassMg: 600,
    method: "micro_drill",
  });
  assert.equal(app.versions[0]!.reviewMode, "committee_majority");
  const reviewers = app.steps.filter((s) => s.kind === "reviewer");
  await svc.decide(app.id, reviewers[0]!.assigneeId, "approve", "");
  await svc.decide(app.id, reviewers[1]!.assigneeId, "approve", "");
  let cur = svc.listApplications().find((a) => a.id === app.id)!;
  assert.equal(cur.state, "reviewing"); // 多数形成，等主任
  // 主任在多数形成前不能签（一张赞成时）；这里两张赞成后签批生效。
  await svc.decide(app.id, "u_dir", "approve", "同意");
  cur = svc.listApplications().find((a) => a.id === app.id)!;
  assert.equal(cur.state, "approved");
  // 未表态的第三票随定稿自动关闭。
  const third = cur.steps.find((s) => s.id === reviewers[2]!.id)!;
  assert.equal(third.status, "closed");
});

test("评审超时自动驳回并释放预占", async () => {
  const svc = await makeService();
  const t0 = new Date("2026-09-10T00:00:00.000Z");
  const app = await svc.createApplication({ ...baseInput, plannedMassMg: 400 });
  await svc.submit(app.id, "u_app_zhou", t0);
  const expired = await svc.expireTimedOut(new Date("2026-09-10T01:00:00.000Z"));
  assert.equal(expired.length, 0);
  const expired2 = await svc.expireTimedOut(new Date("2026-09-13T01:00:00.000Z"));
  assert.equal(expired2.length, 1);
  const cur = svc.listApplications().find((a) => a.id === app.id)!;
  assert.equal(cur.state, "rejected");
  assert.equal(cur.terminalReason, "review_timeout");
  const balance = computeBalance((svc as unknown as { store: { state: DataState } }).store.state, "spm1");
  assert.equal(balance.availableMg, 10000);
});

test("送审后修改关键参数产生新版本，旧版本与旧步骤关闭、预占按新版本计算", async () => {
  const svc = await makeService();
  const app = await submittedRawApp(svc, { plannedMassMg: 200 });
  const oldStepIds = app.steps.map((s) => s.id);
  const amended = await svc.amend(app.id, "u_app_zhou", { plannedMassMg: 350 });
  assert.equal(amended.currentVersionNo, 2);
  assert.equal(amended.versions[0]!.superseded, true);
  assert.equal(amended.versions[1]!.plannedMassMg, 350);
  for (const s of amended.steps) {
    if (oldStepIds.includes(s.id)) assert.equal(s.status, "closed");
  }
  // 新版本拥有全新的在办步骤，旧步骤不再受理。
  const newSteps = amended.steps.filter((s) => s.versionNo === 2);
  assert.ok(newSteps.length >= 1);
  assert.ok(newSteps.every((s) => s.status === "pending"));
  const balance = computeBalance((svc as unknown as { store: { state: DataState } }).store.state, "spm1");
  assert.equal(balance.reservedMg, 350); // 预占按新版本计算
  // 旧版本步骤的受理人不能再决定（当前版本已无分配给他的在办步骤）。
  const oldAssignee = app.steps[0]!.assigneeId;
  const stillAssigned = newSteps.some((s) => s.assigneeId === oldAssignee);
  if (!stillAssigned) {
    await assert.rejects(svc.decide(app.id, oldAssignee, "approve", ""), (e: Error & { code?: string }) =>
      e.code === "conflict");
  }
});

test("他人不能代申请人修改或撤回", async () => {
  const svc = await makeService();
  const app = await submittedRawApp(svc);
  await assert.rejects(svc.amend(app.id, "u_app_wu", { plannedMassMg: 100 }), (e: Error & { code?: string }) =>
    e.code === "forbidden");
  await assert.rejects(svc.withdraw(app.id, "u_app_wu"), (e: Error & { code?: string }) =>
    e.code === "forbidden");
});

test("实际取样偏差追加偏差记录并重算余量，批准结论不变", async () => {
  const svc = await makeService();
  const app = await submittedRawApp(svc, { zoneId: "z_safe", plannedMassMg: 1000, method: "micro_drill" });
  const voters = [...app.steps.map((s) => s.assigneeId)];
  for (const who of voters) {
    await svc.decide(app.id, who, "approve", "");
  }
  const approved = svc.listApplications().find((a) => a.id === app.id)!;
  assert.equal(approved.state, "approved");

  const { cutting, deviation } = await svc.recordCutting(app.id, "u_admin", 1150);
  assert.equal(cutting.actualMassMg, 1150);
  assert.ok(deviation);
  assert.equal(deviation!.deltaMg, 150);
  assert.equal(deviation!.withinTolerance, false); // 15% > 10%
  const cur = svc.listApplications().find((a) => a.id === app.id)!;
  assert.equal(cur.state, "approved"); // 结论不变
  const balance = computeBalance((svc as unknown as { store: { state: DataState } }).store.state, "spm1");
  assert.equal(balance.consumedMg, 1150);
  assert.equal(balance.availableMg, 8850);
  assert.equal(balance.reservedMg, 0);
  // 不能重复登记取样。
  await assert.rejects(svc.recordCutting(app.id, "u_admin", 1), (e: Error & { code?: string }) =>
    e.code === "conflict");
});

test("实际取样超过物理余量被拒绝", async () => {
  const svc = await makeService();
  const app = await submittedRawApp(svc, { zoneId: "z_raw", plannedMassMg: 200 });
  const reviewers = app.steps.filter((s) => s.kind === "reviewer").map((s) => s.assigneeId);
  for (const who of [...reviewers, "u_dir"]) await svc.decide(app.id, who, "approve", "");
  // 批准 200，物理上该区也只剩 2000，取 2001 必失败。
  await assert.rejects(svc.recordCutting(app.id, "u_admin", 2001), (e: Error & { code?: string }) =>
    e.code === "quota_unavailable");
});

test("补件流程：委员要求补件、申请人补交、委员受理，申请人视图可见补件项", async () => {
  const svc = await makeService();
  const app = await submittedRawApp(svc, { plannedMassMg: 200 });
  const reviewer = app.steps[0]!.assigneeId;
  const sup = await svc.requestSupplement(app.id, reviewer, ["补充微损预评估"], "材料不全");
  let view = svc.applicantView(app.id, "u_app_zhou");
  assert.equal(view.supplements[0]!.status, "requested");
  assert.deepEqual(view.supplements[0]!.items, ["补充微损预评估"]);
  await svc.submitSupplement(app.id, sup.id, "u_app_zhou", "已补交评估 PDF");
  await svc.acceptSupplement(app.id, sup.id, reviewer, true, "齐全");
  view = svc.applicantView(app.id, "u_app_zhou");
  assert.equal(view.supplements[0]!.status, "accepted");
});

test("申请人只能看自己的进度", async () => {
  const svc = await makeService();
  const app = await submittedRawApp(svc);
  assert.throws(() => svc.applicantView(app.id, "u_app_wu"), /forbidden|只能查看/);
});

test("管理员标本追溯包含余量、决定规则版本、切割记录与成果到期状态", async () => {
  const svc = await makeService();
  const app = await submittedRawApp(svc, { zoneId: "z_safe", plannedMassMg: 500, method: "powder", resultDueDays: 30 });
  for (const who of app.steps.map((s) => s.assigneeId)) {
    await svc.decide(app.id, who, "approve", "");
  }
  const cutAt = new Date("2026-09-10T00:00:00.000Z");
  await svc.recordCutting(app.id, "u_admin", 500, cutAt.toISOString(), cutAt);
  const trace = svc.specimenTrace("spm1", new Date("2026-10-15T00:00:00.000Z"));
  assert.equal(trace.balance.consumedMg, 500);
  const a = trace.applications[0]!;
  assert.ok(a.decisions.every((d) => d.ruleVersion === RULES_2026_09_V1.version));
  assert.equal(a.cuttings[0]!.actualMassMg, 500);
  assert.equal(a.result!.state, "overdue"); // 30 天，10/10 到期，10/15 已逾期
  await svc.receiveResult(app.id, "u_admin", new Date("2026-10-16T00:00:00.000Z"));
  const trace2 = svc.specimenTrace("spm1", new Date("2026-10-17T00:00:00.000Z"));
  assert.equal(trace2.applications[0]!.result!.state, "received");
});

test("无法定人数时挂起为 submitted 且不预占额度，补员后可重新路由", async () => {
  const svc = await makeService();
  // 仅保留两名评审委员：不够三人委员会。
  const state = (svc as unknown as { store: { state: DataState } }).store.state;
  for (const id of ["u_rev_sun", "u_rev_zhao"]) delete state.users[id];
  const app = await svc.createApplication({ ...baseInput, applicantId: "u_app_zheng", plannedMassMg: 200 });
  await svc.submit(app.id, "u_app_zheng");
  const blocked = svc.listApplications().find((a) => a.id === app.id)!;
  assert.equal(blocked.state, "submitted");
  assert.ok(blocked.blockedReason);
  let balance = computeBalance(state, "spm1");
  assert.equal(balance.reservedMg, 0);
  // 管理员补员。
  state.users["u_rev_new"] = { id: "u_rev_new", name: "新委员", role: "reviewer", institutionId: "inst_x" };
  await svc.retryRouting(app.id, "u_admin");
  const routed = svc.listApplications().find((a) => a.id === app.id)!;
  assert.equal(routed.state, "reviewing");
  balance = computeBalance(state, "spm1");
  assert.equal(balance.reservedMg, 200);
});
