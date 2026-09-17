import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createApp } from "../src/app.js";
import { createContext } from "../src/bootstrap.js";
import type { Server } from "node:http";

let counter = 0;
async function startServer(): Promise<{ server: Server; base: string; stateFile: string }> {
  counter += 1;
  const stateFile = join(tmpdir(), `sampling-http-${process.pid}-${counter}-${Date.now()}.json`);
  const server = createApp(createContext(stateFile));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, base: `http://127.0.0.1:${address.port}`, stateFile };
}

async function call(
  base: string,
  path: string,
  method: string,
  actor: string | null,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (actor) headers["x-user-id"] = actor;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() };
}

test("完整审批链路：建申请→送审→回避后委员会+主任批准→偏差取样→管理员追溯", async () => {
  const { server, base } = await startServer();
  try {
    // A 校申请人，加固区 600mg 微钻 → 多数制委员会 + 主任。
    const created = await call(base, "/api/applications", "POST", "u_app_zhou", {
      specimenId: "spm_fossil_001",
      purpose: "骨组织切片对比",
      zoneId: "zone_reinforced_a",
      plannedMassMg: 600,
      method: "micro_drill",
      deliverable: "原始检测数据与论文",
      resultDueDays: 60,
      confidentialityMonths: 24,
    });
    assert.equal(created.status, 201);
    const appId = created.body.id as string;

    const submitted = await call(base, `/api/applications/${appId}/submit`, "POST", "u_app_zhou");
    assert.equal(submitted.status, 200);
    assert.equal(submitted.body.state, "reviewing");
    const reviewerIds = submitted.body.steps
      .filter((s: any) => s.kind === "reviewer")
      .map((s: any) => s.assigneeId) as string[];
    assert.ok(!reviewerIds.includes("u_rev_li")); // 同校回避
    assert.ok(submitted.body.steps.some((s: any) => s.kind === "director"));

    // 缺身份头 → 401。
    const noAuth = await call(base, `/api/applications/${appId}`, "GET", null);
    assert.equal(noAuth.status, 401);

    // 前两名委员赞成即过半；主任随后批准。
    for (const id of reviewerIds.slice(0, 2)) {
      const r = await call(base, `/api/applications/${appId}/decisions`, "POST", id, {
        vote: "approve",
        comment: "方案合理",
      });
      assert.equal(r.status, 200);
    }
    const dir = await call(base, `/api/applications/${appId}/decisions`, "POST", "u_dir_chen", {
      vote: "approve",
      comment: "同意",
    });
    assert.equal(dir.status, 200);
    assert.equal(dir.body.state, "approved");

    // 实际取 650mg：偏差 +8.3%，在 10% 容差内。
    const cut = await call(base, `/api/applications/${appId}/cuttings`, "POST", "u_admin", {
      actualMassMg: 650,
    });
    assert.equal(cut.status, 201);
    assert.equal(cut.body.deviation.deltaMg, 50);
    assert.equal(cut.body.deviation.withinTolerance, true);

    // 申请人视图可见进度与成果倒计时。
    const view = await call(base, `/api/applications/${appId}`, "GET", "u_app_zhou");
    assert.equal(view.status, 200);
    assert.equal(view.body.state, "approved");
    assert.equal(view.body.result.state, "not_due");
    assert.ok(view.body.events.length >= 5);

    // 管理员追溯：余量 = 10000 - 650，保留规则版本与切割记录。
    const trace = await call(base, "/api/admin/specimens/spm_fossil_001/trace", "GET", "u_admin");
    assert.equal(trace.status, 200);
    assert.equal(trace.body.balance.consumedMg, 650);
    assert.equal(trace.body.balance.availableMg, 9350);
    assert.equal(trace.body.applications[0].cuttings[0].actualMassMg, 650);
    assert.ok(
      trace.body.applications[0].decisions.every((d: any) => d.ruleVersion === "rules-2026-09-v1"),
    );

    // 申请人不能访问管理员接口。
    const forbidden = await call(base, "/api/admin/applications", "GET", "u_app_zhou");
    assert.equal(forbidden.status, 403);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});

test("未加固区高破坏方法被系统驳回；送审后改动产生新版本", async () => {
  const { server, base } = await startServer();
  try {
    const created = await call(base, "/api/applications", "POST", "u_app_wu", {
      specimenId: "spm_fossil_001",
      purpose: "剖面分析",
      zoneId: "zone_unreinforced_b",
      plannedMassMg: 100,
      method: "section",
      deliverable: "切片返还",
      resultDueDays: 30,
      confidentialityMonths: 12,
    });
    const appId = created.body.id as string;
    const rejected = await call(base, `/api/applications/${appId}/submit`, "POST", "u_app_wu");
    assert.equal(rejected.body.state, "rejected");
    assert.equal(rejected.body.terminalReason, "method_too_destructive");

    // 新申请送审后改参数 → 版本 2，旧版本标记 superseded。
    const c2 = await call(base, "/api/applications", "POST", "u_app_wu", {
      specimenId: "spm_fossil_001",
      purpose: "表面采样",
      zoneId: "zone_unreinforced_b",
      plannedMassMg: 100,
      method: "surface_swab",
      deliverable: "数据",
      resultDueDays: 30,
      confidentialityMonths: 12,
    });
    const id2 = c2.body.id as string;
    await call(base, `/api/applications/${id2}/submit`, "POST", "u_app_wu");
    const amended = await call(base, `/api/applications/${id2}/amend`, "POST", "u_app_wu", {
      plannedMassMg: 150,
    });
    assert.equal(amended.status, 200);
    assert.equal(amended.body.currentVersionNo, 2);
    assert.equal(amended.body.versions[0].superseded, true);
    assert.equal(amended.body.versions[1].plannedMassMg, 150);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});

test("并发送审不会双重预占：至多一份未加固区申请进入评审", async () => {
  const { server, base } = await startServer();
  try {
    const mk = async (actor: string) =>
      call(base, "/api/applications", "POST", actor, {
        specimenId: "spm_fossil_001",
        purpose: "同位素测试",
        zoneId: "zone_unreinforced_b",
        plannedMassMg: 1800,
        method: "powder",
        deliverable: "报告",
        resultDueDays: 45,
        confidentialityMonths: 12,
      });
    const [a, b, c] = await Promise.all([
      mk("u_app_zhou"),
      mk("u_app_wu"),
      mk("u_app_zheng"),
    ]);
    const ids = [a, b, c].map((r) => r.body.id as string);
    const outcomes = await Promise.all(
      ids.map((id, i) =>
        call(base, `/api/applications/${id}/submit`, "POST",
          ["u_app_zhou", "u_app_wu", "u_app_zheng"][i]!,
        ),
      ),
    );
    const reviewing = outcomes.filter((o) => o.body.state === "reviewing").length;
    const quotaRejected = outcomes.filter((o) =>
      o.status === 409 && o.body.error === "quota_exceeded").length;
    const blocked = outcomes.filter((o) => o.body.state === "submitted").length;
    // B 校因回避不足法定人数会挂起（不预占）；其余两校竞争同一额度，恰好一份成功。
    assert.equal(reviewing + blocked + quotaRejected, 3);
    assert.ok(reviewing <= 1);

    const trace = await call(base, "/api/admin/specimens/spm_fossil_001/trace", "GET", "u_admin");
    assert.equal(trace.body.balance.reservedMg, reviewing === 1 ? 1800 : 0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});
