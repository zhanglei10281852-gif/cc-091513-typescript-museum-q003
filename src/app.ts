/**
 * HTTP 适配层。鉴权采用请求头：
 *   x-user-id: 用户标识
 *   x-user-roles: researcher,reviewer,admin（逗号分隔）
 * 生产部署应替换为网关签发的身份；领域层只认 Actor。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { DecisionService } from "./domain/decision.js";
import type { QueryService } from "./domain/views.js";
import { DomainError } from "./domain/errors.js";
import type { Actor, SamplingMethod, UserRole } from "./domain/types.js";
import { RULES } from "./domain/rules.js";

export const serviceName = "馆藏科研取样决策服务";

export interface AppDeps {
  decisions: DecisionService;
  queries: QueryService;
}

export function healthPayload(): { status: "ok"; service: string; ruleVersion: string } {
  return { status: "ok", service: serviceName, ruleVersion: RULES.ruleVersion };
}

const ROLES: UserRole[] = ["researcher", "reviewer", "admin"];

function actorFromRequest(request: IncomingMessage): Actor {
  const userId = request.headers["x-user-id"];
  if (typeof userId !== "string" || !userId.trim()) {
    throw new DomainError("unauthorized", "缺少 x-user-id 请求头", 401);
  }
  const rawRoles = request.headers["x-user-roles"];
  const roles =
    typeof rawRoles === "string"
      ? rawRoles
          .split(",")
          .map((role) => role.trim())
          .filter((role): role is UserRole => ROLES.includes(role as UserRole))
      : [];
  return { userId: userId.trim(), roles };
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 1_000_000) throw new DomainError("body_too_large", "请求体超过 1MB 限制", 413);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new DomainError("bad_json", "请求体必须是 JSON 对象", 400);
  }
}

function str(body: Record<string, unknown>, key: string, required = true): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) {
    if (required) throw new DomainError("missing_field", `缺少字段 ${key}`, 400, { field: key });
    return undefined;
  }
  if (typeof value !== "string") {
    throw new DomainError("invalid_field", `字段 ${key} 必须是字符串`, 400, { field: key });
  }
  return value;
}

function num(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new DomainError("invalid_field", `字段 ${key} 必须是数字`, 400, { field: key });
  }
  return value;
}

function strArray(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new DomainError("invalid_field", `字段 ${key} 必须是字符串数组`, 400, { field: key });
  }
  return value as string[];
}

function numInt(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new DomainError("invalid_field", `字段 ${key} 必须是整数`, 400, { field: key });
  }
  return value;
}

type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
  actor: Actor,
  body: Record<string, unknown>,
  params: string[],
  search: URLSearchParams,
) => Promise<void> | void;

interface Route {
  method: string;
  /** 以 ":" 开头的段为参数。 */
  segments: string[];
  handler: Handler;
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

export function createApp(deps?: AppDeps): Server {
  // 允许只做健康检查测试时无参构造；业务路由在缺依赖时返回 503。
  const routes = deps ? buildRoutes(deps) : [];

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/health") {
        send(response, 200, healthPayload());
        return;
      }
      if (!deps) {
        send(response, 503, { error: "service_not_configured" });
        return;
      }

      const body = ["POST", "PUT", "PATCH"].includes(request.method ?? "")
        ? await readJson(request)
        : {};
      const actor = actorFromRequest(request);

      const parts = url.pathname.split("/").filter(Boolean);
      for (const route of routes) {
        if (route.method !== request.method || route.segments.length !== parts.length) continue;
        const params: string[] = [];
        let matched = true;
        for (let i = 0; i < route.segments.length; i += 1) {
          const segment = route.segments[i]!;
          const actual = parts[i]!;
          if (segment.startsWith(":")) params.push(decodeURIComponent(actual));
          else if (segment !== actual) {
            matched = false;
            break;
          }
        }
        if (!matched) continue;
        await route.handler(request, response, actor, body, params, url.searchParams);
        return;
      }
      send(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof DomainError) {
        send(response, error.statusCode, { error: error.code, message: error.message, details: error.details ?? undefined });
        return;
      }
      const message = error instanceof Error ? error.message : "internal_error";
      send(response, 500, { error: "internal_error", message });
    }
  });
}

function buildRoutes(deps: AppDeps): Route[] {
  const { decisions, queries } = deps;
  // 领域方法多为异步（互斥区），统一 await 后再序列化。
  const ok = async (response: ServerResponse, payload: unknown | Promise<unknown>): Promise<void> =>
    send(response, 200, await payload);

  // ---------- 管理：基础数据 ----------
  const routes: Route[] = [
    {
      method: "POST",
      segments: ["admin", "specimens"],
      handler: (_req, res, actor, body) =>
        ok(res, decisions.createSpecimen(actor, {
          ...(str(body, "id", false) !== undefined ? { id: str(body, "id", false) } : {}),
          code: str(body, "code")!,
          name: str(body, "name")!,
          zones: specZones(body),
        })),
    },
    {
      method: "POST",
      segments: ["admin", "specimens", ":id", "zones"],
      handler: (_req, res, actor, body, params) =>
        ok(res, decisions.addZone(actor, params[0]!, {
          id: str(body, "id")!,
          name: str(body, "name")!,
          reinforced: body.reinforced === true,
          initialMassMg: num(body, "initialMassMg"),
        })),
    },
    {
      method: "PUT",
      segments: ["admin", "reviewers", ":id"],
      handler: (_req, res, actor, body, params) =>
        ok(res, decisions.upsertReviewer(actor, {
          id: params[0]!,
          name: str(body, "name")!,
          ...(str(body, "orgId", false) !== undefined ? { orgId: str(body, "orgId", false) } : {}),
          isDirector: body.isDirector === true,
          conflictUserIds: strArray(body, "conflictUserIds"),
          conflictOrgIds: strArray(body, "conflictOrgIds"),
        })),
    },

    // ---------- 研究人员 ----------
    {
      method: "POST",
      segments: ["applications"],
      handler: (_req, res, actor, body) =>
        ok(res, decisions.createApplication(actor, {
          specimenId: str(body, "specimenId")!,
          applicantOrgId: str(body, "applicantOrgId")!,
          draft: draftFromBody(draftBody(body)),
        })),
    },
    {
      method: "POST",
      segments: ["applications", ":id", "revise"],
      handler: (_req, res, actor, body, params) =>
        ok(res, decisions.reviseApplication(actor, params[0]!, draftFromBody(draftBody(body)))),
    },
    {
      method: "POST",
      segments: ["applications", ":id", "submit"],
      handler: (_req, res, actor, _body, params) =>
        ok(res, decisions.submitApplication(actor, params[0]!)),
    },
    {
      method: "POST",
      segments: ["applications", ":id", "withdraw"],
      handler: (_req, res, actor, _body, params) =>
        ok(res, decisions.withdrawApplication(actor, params[0]!)),
    },
    {
      method: "POST",
      segments: ["applications", ":id", "supplements", ":itemId"],
      handler: (_req, res, actor, body, params) =>
        ok(res, decisions.submitSupplement(actor, params[0]!, params[1]!, str(body, "response")!)),
    },
    {
      method: "GET",
      segments: ["me", "applications"],
      handler: (_req, res, actor) => ok(res, queries.researcherDashboard(actor)),
    },
    {
      method: "GET",
      segments: ["applications", ":id"],
      handler: (_req, res, actor, _body, params) =>
        ok(res, queries.applicationDetail(actor, params[0]!)),
    },

    // ---------- 委员 ----------
    {
      method: "GET",
      segments: ["reviewer", "queue"],
      handler: (_req, res, actor) => ok(res, queries.reviewerQueue(actor)),
    },
    {
      method: "POST",
      segments: ["applications", ":id", "votes"],
      handler: (_req, res, actor, body, params) => {
        const value = str(body, "value")!;
        if (value !== "approve" && value !== "reject" && value !== "request_changes") {
          throw new DomainError("invalid_field", "value 必须是 approve/reject/request_changes", 400);
        }
        return ok(res, decisions.castVote(actor, params[0]!, value, {
          ...(str(body, "comment", false) !== undefined ? { comment: str(body, "comment", false) } : {}),
          ...(str(body, "supplementField", false) !== undefined ? { supplementField: str(body, "supplementField", false) } : {}),
          ...(str(body, "supplementNote", false) !== undefined ? { supplementNote: str(body, "supplementNote", false) } : {}),
        }));
      },
    },
    {
      method: "POST",
      segments: ["reviewer", "sweep"],
      handler: (_req, res, actor) => ok(res, decisions.sweepTimeouts(actor)),
    },
    {
      method: "POST",
      segments: ["reviewer", "refresh-results"],
      handler: (_req, res, actor) => ok(res, decisions.refreshResultStates(actor)),
    },

    // ---------- 管理员 ----------
    {
      method: "POST",
      segments: ["admin", "applications", ":id", "regenerate-path"],
      handler: (_req, res, actor, _body, params) =>
        ok(res, decisions.regeneratePath(actor, params[0]!)),
    },
    {
      method: "POST",
      segments: ["admin", "applications", ":id", "cuttings"],
      handler: (_req, res, actor, body, params) =>
        ok(res, decisions.recordCutting(actor, params[0]!, {
          actualMassMg: num(body, "actualMassMg"),
          actualMethod: str(body, "actualMethod")! as SamplingMethod,
          ...(str(body, "sampledAt", false) !== undefined ? { sampledAt: str(body, "sampledAt", false) } : {}),
          ...(str(body, "note", false) !== undefined ? { note: str(body, "note", false) } : {}),
        })),
    },
    {
      method: "POST",
      segments: ["admin", "applications", ":id", "result-received"],
      handler: (_req, res, actor, body, params) =>
        ok(res, decisions.confirmResultReceived(actor, params[0]!, str(body, "note", false))),
    },
    {
      method: "GET",
      segments: ["admin", "trace"],
      handler: (_req, res, actor, _body, _params, search) => {
        if (!actor.roles.includes("admin")) {
          throw new DomainError("forbidden", "需要 admin 角色", 403);
        }
        return ok(res, queries.adminTrace(search.get("specimenId") ?? undefined));
      },
    },
  ];

  return routes;
}

function specZones(body: Record<string, unknown>) {
  const value = body.zones;
  if (!Array.isArray(value)) {
    throw new DomainError("invalid_field", "字段 zones 必须是数组", 400, { field: "zones" });
  }
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw new DomainError("invalid_field", "zones 元素必须是对象", 400);
    }
    const zone = entry as Record<string, unknown>;
    return {
      id: str(zone, "id")!,
      name: str(zone, "name")!,
      reinforced: zone.reinforced === true,
      initialMassMg: num(zone, "initialMassMg"),
    };
  });
}

/** 申请参数既可平铺在请求体，也可嵌套在 draft 字段内（与领域接口一致）。 */
function draftBody(body: Record<string, unknown>): Record<string, unknown> {
  const nested = body.draft;
  if (nested !== undefined) {
    if (typeof nested !== "object" || nested === null || Array.isArray(nested)) {
      throw new DomainError("invalid_field", "字段 draft 必须是对象", 400, { field: "draft" });
    }
    return nested as Record<string, unknown>;
  }
  return body;
}

function draftFromBody(body: Record<string, unknown>) {
  return {
    purpose: str(body, "purpose")!,
    zoneId: str(body, "zoneId")!,
    locationNotes: str(body, "locationNotes")!,
    estimatedMassMg: num(body, "estimatedMassMg"),
    method: str(body, "method")! as SamplingMethod,
    deliverables: strArray(body, "deliverables"),
    resultReturnBy: str(body, "resultReturnBy")!,
    confidentialityMonths: numInt(body, "confidentialityMonths"),
  };
}
