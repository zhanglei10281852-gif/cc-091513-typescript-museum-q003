import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { DomainError } from "./domain/errors.js";
import {
  REQUEST_STATES,
  RESULT_STATES,
  SAMPLING_METHODS,
} from "./domain/types.js";
import { RULE_HISTORY, latestRuleVersion } from "./domain/rules.js";
import {
  createContext,
  type Context,
} from "./bootstrap.js";

export const serviceName = "馆藏科研取样决策服务";

export function healthPayload(): { status: "ok"; service: string } {
  return { status: "ok", service: serviceName };
}

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  body: unknown,
  ctx: Context,
  actorId: string | null,
) => Promise<void> | void;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  adminOnly: boolean;
  handler: Handler;
}

function route(
  method: string,
  path: string,
  adminOnly: boolean,
  handler: Handler,
): Route {
  const paramNames: string[] = [];
  const patternText = path.replace(/:([a-zA-Z]+)/g, (_, name: string) => {
    paramNames.push(name);
    return "([^/]+)";
  });
  return {
    method,
    pattern: new RegExp(`^${patternText}$`),
    paramNames,
    adminOnly,
    handler,
  };
}

const routes: Route[] = [
  route("GET", "/api/enums", false, (_req, res, _p, _b, ctx) => {
    send(res, 200, {
      request_states: REQUEST_STATES,
      sampling_methods: SAMPLING_METHODS,
      result_states: RESULT_STATES,
      current_rule_version: ctx.store.state.currentRuleVersion,
    });
  }),
  route("GET", "/api/rules", false, (_req, res, _p, _b) => {
    send(res, 200, { current: latestRuleVersion(), history: RULE_HISTORY });
  }),

  // ---------------- 申请人 ----------------
  route("GET", "/api/applications", false, (_req, res, _p, _b, ctx, actorId) => {
    send(res, 200, ctx.service.myApplications(actorId!));
  }),
  route("POST", "/api/applications", false, async (_req, res, _p, body, ctx, actorId) => {    const b = asObject(body);
    const app = await ctx.service.createApplication({
      applicantId: actorId!,
      specimenId: requireString(b.specimenId, "specimenId"),
      purpose: requireString(b.purpose, "purpose"),
      zoneId: requireString(b.zoneId, "zoneId"),
      plannedMassMg: requirePositiveNumber(b.plannedMassMg, "plannedMassMg"),
      method: requireMethod(b.method),
      deliverable: requireString(b.deliverable, "deliverable"),
      resultDueDays: requirePositiveNumber(b.resultDueDays, "resultDueDays"),
      confidentialityMonths: requireNonNegativeNumber(
        b.confidentialityMonths,
        "confidentialityMonths",
      ),
    });
    send(res, 201, app);
  }),
  route("POST", "/api/applications/:id/submit", false, async (_req, res, p, _b, ctx, actorId) => {
    send(res, 200, await ctx.service.submit(p.id!, actorId!));
  }),
  route("POST", "/api/applications/:id/amend", false, async (_req, res, p, body, ctx, actorId) => {
    const b = asObject(body);
    const changes: Record<string, unknown> = {};
    const allowed = [
      "purpose",
      "zoneId",
      "plannedMassMg",
      "method",
      "deliverable",
      "resultDueDays",
      "confidentialityMonths",
    ] as const;
    for (const key of allowed) {
      if (b[key] !== undefined) changes[key] = b[key];
    }
    if (Object.keys(changes).length === 0) {
      throw new DomainError("validation_error", "至少提供一项需要修改的关键参数", 400);
    }
    send(res, 200, await ctx.service.amend(p.id!, actorId!, changes as never));
  }),
  route("POST", "/api/applications/:id/withdraw", false, async (_req, res, p, _b, ctx, actorId) => {
    send(res, 200, await ctx.service.withdraw(p.id!, actorId!));
  }),
  route("GET", "/api/applications/:id", false, async (_req, res, p, _b, ctx, actorId) => {
    send(res, 200, ctx.service.applicantView(p.id!, actorId!));
  }),
  route("POST", "/api/applications/:id/supplements", false, async (_req, res, p, body, ctx, actorId) => {
    const b = asObject(body);
    const items = b.items;
    if (!Array.isArray(items) || items.some((i) => typeof i !== "string" || !i.trim())) {
      throw new DomainError("validation_error", "items 必须是非空字符串数组", 400);
    }
    send(
      res,
      201,
      await ctx.service.requestSupplement(
        p.id!,
        actorId!,
        items as string[],
        requireString(b.reason, "reason"),
      ),
    );
  }),
  route("POST", "/api/applications/:id/decisions", false, async (_req, res, p, body, ctx, actorId) => {
    const b = asObject(body);
    const vote = b.vote;
    if (vote !== "approve" && vote !== "reject") {
      throw new DomainError("validation_error", "vote 必须为 approve 或 reject", 400);
    }
    send(
      res,
      200,
      await ctx.service.decide(
        p.id!,
        actorId!,
        vote,
        typeof b.comment === "string" ? b.comment : "",
      ),
    );
  }),
  route("POST", "/api/applications/:id/cuttings", false, async (_req, res, p, body, ctx, actorId) => {
    const b = asObject(body);
    const result = await ctx.service.recordCutting(
      p.id!,
      actorId!,
      requirePositiveNumber(b.actualMassMg, "actualMassMg"),
      b.sampledAt === undefined ? undefined : requireString(b.sampledAt, "sampledAt"),
    );
    send(res, 201, result);
  }),
  route("POST", "/api/supplements/:sid/response", false, async (_req, res, p, body, ctx, actorId) => {
    const b = asObject(body);
    send(
      res,
      200,
      await ctx.service.submitSupplement(
        requireString(b.applicationId, "applicationId"),
        p.sid!,
        actorId!,
        requireString(b.response, "response"),
      ),
    );
  }),
  route("POST", "/api/supplements/:sid/accept", false, async (_req, res, p, body, ctx, actorId) => {
    const b = asObject(body);
    send(
      res,
      200,
      await ctx.service.acceptSupplement(
        requireString(b.applicationId, "applicationId"),
        p.sid!,
        actorId!,
        b.accept === true,
        typeof b.comment === "string" ? b.comment : "",
      ),
    );
  }),
  route("POST", "/api/applications/:id/result/receive", false, async (_req, res, p, _b, ctx, actorId) => {
    send(res, 200, await ctx.service.receiveResult(p.id!, actorId!));
  }),

  // ---------------- 管理员 ----------------
  route("POST", "/api/admin/specimens", true, async (_req, res, _p, body, ctx) => {
    const b = asObject(body);
    const zones = b.zones;
    if (!Array.isArray(zones)) {
      throw new DomainError("validation_error", "zones 必须为数组", 400);
    }
    send(
      res,
      201,
      await ctx.service.createSpecimen({
        id: requireString(b.id, "id"),
        name: requireString(b.name, "name"),
        initialMassMg: requirePositiveNumber(b.initialMassMg, "initialMassMg"),
        zones: zones.map((z) => {
          const zo = asObject(z);
          return {
            id: requireString(zo.id, "zone.id"),
            name: requireString(zo.name, "zone.name"),
            reinforced: zo.reinforced === true,
            initialMassMg: requirePositiveNumber(zo.initialMassMg, "zone.initialMassMg"),
          };
        }),
      }),
    );
  }),
  route("POST", "/api/admin/users", true, async (_req, res, _p, body, ctx) => {
    const b = asObject(body);
    const role = b.role;
    if (!["applicant", "reviewer", "director", "admin"].includes(String(role))) {
      throw new DomainError("validation_error", "未知角色", 400);
    }
    send(
      res,
      201,
      await ctx.service.createUser({
        id: requireString(b.id, "id"),
        name: requireString(b.name, "name"),
        role: role as never,
        institutionId: b.institutionId === undefined ? null : requireString(b.institutionId, "institutionId"),
      }),
    );
  }),
  route("POST", "/api/admin/recusals", true, async (_req, res, _p, body, ctx) => {
    const b = asObject(body);
    send(
      res,
      201,
      await ctx.service.addRecusal({
        reviewerId: requireString(b.reviewerId, "reviewerId"),
        applicantId: b.applicantId === undefined ? undefined : requireString(b.applicantId, "applicantId"),
        institutionId: b.institutionId === undefined ? undefined : requireString(b.institutionId, "institutionId"),
        reason: requireString(b.reason, "reason"),
      }),
    );
  }),
  route("POST", "/api/admin/applications/:id/retry-routing", true, async (_req, res, p, _b, ctx, actorId) => {
    send(res, 200, await ctx.service.retryRouting(p.id!, actorId!));
  }),
  route("POST", "/api/admin/expire-timeouts", true, async (_req, res, _p, _b, ctx) => {
    const expired = await ctx.service.expireTimedOut();
    send(res, 200, { expired: expired.map((a) => a.id) });
  }),
  route("GET", "/api/admin/applications", true, async (_req, res, _p, _b, ctx) => {
    send(res, 200, ctx.service.listApplications());
  }),
  route("GET", "/api/admin/specimens/:id/trace", true, async (_req, res, p, _b, ctx) => {
    send(res, 200, ctx.service.specimenTrace(p.id!));
  }),
  route("POST", "/api/admin/applications/:id/deviations/:did/annotate", true, async (_req, res, p, body, ctx, actorId) => {
    const b = asObject(body);
    send(
      res,
      200,
      await ctx.service.annotateDeviation(
        p.id!,
        p.did!,
        actorId!,
        requireString(b.note, "note"),
      ),
    );
  }),
];

export function createApp(ctx: Context = createContext()): Server {
  return createServer((request, response) => {
    void handle(request, response, ctx);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: Context): Promise<void> {
  try {
    if (req.method === "GET" && req.url === "/health") {
      send(res, 200, healthPayload());
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/api/")) {
      send(res, 404, { error: "not_found" });
      return;
    }

    const matched = routes.find(
      (r) => r.method === req.method && r.pattern.test(url.pathname),
    );
    if (!matched) {
      send(res, 404, { error: "not_found", path: url.pathname });
      return;
    }

    const actorId = req.headers["x-user-id"];
    const actor = Array.isArray(actorId) ? actorId[0] : actorId;
    if (!actor) {
      send(res, 401, { error: "unauthorized", message: "缺少 x-user-id 请求头" });
      return;
    }
    const user = ctx.store.state.users[actor];
    if (!user) {
      send(res, 401, { error: "unauthorized", message: "用户不存在" });
      return;
    }
    if (matched.adminOnly && user.role !== "admin") {
      send(res, 403, { error: "forbidden", message: "需要管理员身份" });
      return;
    }

    const match = matched.pattern.exec(url.pathname)!;
    const params: Record<string, string> = {};
    matched.paramNames.forEach((name, i) => {
      params[name] = decodeURIComponent(match[i + 1]!);
    });

    let body: unknown = {};
    if (req.method === "POST") {
      body = await readJson(req);
    }
    await matched.handler(req, res, params, body, ctx, actor);
  } catch (error) {
    if (error instanceof DomainError) {
      send(res, error.statusCode, {
        error: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    send(res, 500, { error: "internal_error", message });
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new DomainError("validation_error", "请求体不是合法 JSON", 400);
  }
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new DomainError("validation_error", "请求体必须是 JSON 对象", 400);
  }
  return body as Record<string, unknown>;
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== "string" || !v.trim()) {
    throw new DomainError("validation_error", `字段 ${field} 必须是非空字符串`, 400);
  }
  return v;
}

function requirePositiveNumber(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new DomainError("validation_error", `字段 ${field} 必须是正数`, 400);
  }
  return v;
}

function requireNonNegativeNumber(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw new DomainError("validation_error", `字段 ${field} 不能为负数`, 400);
  }
  return v;
}

function requireMethod(v: unknown): (typeof SAMPLING_METHODS)[number] {
  if (typeof v !== "string" || !SAMPLING_METHODS.includes(v as never)) {
    throw new DomainError(
      "validation_error",
      `method 必须是 ${SAMPLING_METHODS.join(" / ")} 之一`,
      400,
    );
  }
  return v as (typeof SAMPLING_METHODS)[number];
}
