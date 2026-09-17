import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";

import { createApp } from "../src/app.js";
import { DecisionService } from "../src/domain/decision.js";
import { QueryService } from "../src/domain/views.js";
import { DomainStore } from "../src/domain/store.js";
import type { FakeClock } from "./clock-fixture.js";
import { fakeClock, iso, plusDays } from "./clock-fixture.js";
import type { ApplicationDraft } from "../src/domain/types.js";

interface TestServer {
  origin: string;
  close: () => Promise<void>;
  decisions: DecisionService;
  clock: FakeClock;
}

async function startServer(): Promise<TestServer> {
  const clock = fakeClock();
  const store = new DomainStore(clock);
  const decisions = new DecisionService(store, clock);
  const queries = new QueryService(() => store.snapshot(), clock);
  const server = createApp({ decisions, queries });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
    decisions,
    clock,
  };
}

async function seed(ts: TestServer): Promise<void> {
  await ts.decisions.createSpecimen(
    { userId: "admin", roles: ["admin"] },
    {
      id: "SPM1",
      code: "PAL-001",
      name: "稀有模式标本",
      zones: [{ id: "Z-UNREINFORCED", name: "仅存未加固区", reinforced: false, initialMassMg: 800 }],
    },
  );
  for (const [id, orgId, isDirector] of [
    ["rv-li", "ORG-GJD", false],
    ["rv-chen", "ORG-DC", false],
    ["rv-zhao", "ORG-XSD", false],
    ["rv-sun", undefined, true],
  ] as Array<[string, string | undefined, boolean]>) {
    await ts.decisions.upsertReviewer({ userId: "admin", roles: ["admin"] }, {
      id,
      name: id,
      ...(orgId ? { orgId } : {}),
      isDirector,
      conflictUserIds: [],
      conflictOrgIds: [],
    });
  }
}

function draft(overrides: Partial<ApplicationDraft> = {}): ApplicationDraft {
  return {
    purpose: "古组织学切片研究",
    zoneId: "Z-UNREINFORCED",
    locationNotes: "背侧未加固表层",
    estimatedMassMg: 300,
    method: "section",
    deliverables: ["切片图像", "余样返还"],
    resultReturnBy: iso(plusDays(new Date("2026-09-01T00:00:00.000Z"), 45)),
    confidentialityMonths: 6,
    ...overrides,
  };
}

function headers(actor: { userId: string; roles: string[] }): Record<string, string> {
  return { "x-user-id": actor.userId, "x-user-roles": actor.roles.join(",") };
}

async function jsonRequest(
  origin: string,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${origin}${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const body = (await response.json()) as unknown;
  return { status: response.status, body };
}

test("HTTP：缺身份头 401，健康检查无需身份", async () => {
  const ts = await startServer();
  try {
    const health = await jsonRequest(ts.origin, "/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.ruleVersion, "1.0.0");

    const noAuth = await jsonRequest(ts.origin, "/me/applications");
    assert.equal(noAuth.status, 401);
    assert.equal(noAuth.body.error, "unauthorized");
  } finally {
    await ts.close();
  }
});

test("HTTP：完整审批链路（创建→并发送审竞争→委员会+主任批准→切割偏差→追溯）", async () => {
  const ts = await startServer();
  try {
    await seed(ts);

    // 两份草稿争用仅存未加固区（各 500mg，合计超过 800mg）。
    const mk = async (user: string, org: string) => {
      const res = await jsonRequest(ts.origin, "/applications", {
        method: "POST",
        headers: headers({ userId: user, roles: ["researcher"] }),
        body: { specimenId: "SPM1", applicantOrgId: org, draft: draft({ estimatedMassMg: 500 }) },
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return res.body.id as string;
    };
    const [idA, idB] = await Promise.all([mk("u-a", "ORG-A"), mk("u-b", "ORG-B")]);

    const submitted = await Promise.all([
      jsonRequest(ts.origin, `/applications/${idA}/submit`, {
        method: "POST",
        headers: headers({ userId: "u-a", roles: ["researcher"] }),
      }),
      jsonRequest(ts.origin, `/applications/${idB}/submit`, {
        method: "POST",
        headers: headers({ userId: "u-b", roles: ["researcher"] }),
      }),
    ]);
    const statuses = submitted.map((item) => item.status).sort();
    assert.deepEqual(statuses, [200, 409]);
    const winner = submitted.find((item) => item.status === 200)!.body.application.id as string;
    const loser = winner === idA ? idB : idA;
    assert.equal(submitted.find((item) => item.status === 409)!.body.error, "material_unavailable");

    // 500mg 未加固区 → 委员会（3 人）；取后余 300 ≥ 200 安全库存，无主任签批。
    const vote = async (reviewer: string, value: string) =>
      jsonRequest(ts.origin, `/applications/${winner}/votes`, {
        method: "POST",
        headers: headers({ userId: reviewer, roles: ["reviewer"] }),
        body: { value },
      });
    assert.equal((await vote("rv-li", "approve")).status, 200);
    assert.equal((await vote("rv-chen", "reject")).status, 200);
    assert.equal((await vote("rv-zhao", "approve")).status, 200);

    const me = await jsonRequest(ts.origin, "/me/applications", {
      headers: headers({ userId: winner === idA ? "u-a" : "u-b", roles: ["researcher"] }),
    });
    assert.equal(me.status, 200);
    assert.equal(me.body.applications[0].application.state, "approved");

    // 实际取 540mg（+8%，容忍内）。
    const cutting = await jsonRequest(ts.origin, `/admin/applications/${winner}/cuttings`, {
      method: "POST",
      headers: headers({ userId: "admin", roles: ["admin"] }),
      body: { actualMassMg: 540, actualMethod: "section" },
    });
    assert.equal(cutting.status, 200);
    assert.equal(cutting.body.variance.withinTolerance, true);
    assert.equal(cutting.body.variance.deltaMg, 40);

    // 落选申请此时撤回（实际尚未送审成功，直接撤回草稿）。
    const withdrawn = await jsonRequest(ts.origin, `/applications/${loser}/withdraw`, {
      method: "POST",
      headers: headers({ userId: loser === idA ? "u-a" : "u-b", roles: ["researcher"] }),
    });
    assert.equal(withdrawn.status, 200);

    const trace = await jsonRequest(ts.origin, "/admin/trace?specimenId=SPM1", {
      headers: headers({ userId: "admin", roles: ["admin"] }),
    });
    assert.equal(trace.status, 200);
    const zone = trace.body.specimens[0].zones[0];
    assert.equal(zone.consumedMassMg, 540);
    assert.equal(zone.availableMassMg, 260);
    assert.equal(zone.heldMassMg, 0);
    assert.equal(zone.cuttings[0].variance.ruleVersion, "1.0.0");

    // 研究员不能访问管理员追溯。
    const forbidden = await jsonRequest(ts.origin, "/admin/trace", {
      headers: headers({ userId: "u-a", roles: ["researcher"] }),
    });
    assert.equal(forbidden.status, 403);
  } finally {
    await ts.close();
  }
});

test("HTTP：回避阻塞时不预占，增补委员后重建路径", async () => {
  const ts = await startServer();
  try {
    await seed(ts);
    // 古甲大学申请：rv-li 同单位回避、rv-sun 无冲突（seed 中未配置），
    // 委员会池 = rv-chen/rv-zhao/rv-sun？——主任不进委员会，故仅 2 人 → 阻塞。
    // 先把主任配置为对古甲大学回避，确保签批池语义一致。
    await ts.decisions.upsertReviewer({ userId: "admin", roles: ["admin"] }, {
      id: "rv-sun",
      name: "rv-sun",
      isDirector: true,
      conflictUserIds: [],
      conflictOrgIds: ["ORG-GJD"],
    });

    const created = await jsonRequest(ts.origin, "/applications", {
      method: "POST",
      headers: headers({ userId: "u-g", roles: ["researcher"] }),
      body: { specimenId: "SPM1", applicantOrgId: "ORG-GJD", draft: draft() },
    });
    const id = created.body.id as string;
    const submitted = await jsonRequest(ts.origin, `/applications/${id}/submit`, {
      method: "POST",
      headers: headers({ userId: "u-g", roles: ["researcher"] }),
    });
    assert.equal(submitted.status, 200);
    assert.equal(submitted.body.reviewPath.status, "blocked_recusal");
    assert.equal(submitted.body.hold, undefined);

    await ts.decisions.upsertReviewer({ userId: "admin", roles: ["admin"] }, {
      id: "rv-zhou",
      name: "rv-zhou",
      orgId: "ORG-OTH",
      isDirector: false,
      conflictUserIds: [],
      conflictOrgIds: [],
    });
    const regenerated = await jsonRequest(ts.origin, `/admin/applications/${id}/regenerate-path`, {
      method: "POST",
      headers: headers({ userId: "admin", roles: ["admin"] }),
    });
    assert.equal(regenerated.status, 200);
    assert.equal(regenerated.body.status, "active");
  } finally {
    await ts.close();
  }
});
