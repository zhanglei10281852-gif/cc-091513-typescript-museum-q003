/**
 * 进程入口：装配存储、服务与 HTTP，加载 .runtime/state.json，
 * 退出时落盘；首次启动用 seed() 写入演示用的标本、分区与委员。
 */
import { createApp } from "./app.js";
import { DecisionService } from "./domain/decision.js";
import { QueryService } from "./domain/views.js";
import { DomainStore, loadState, saveState } from "./domain/store.js";
import { systemClock } from "./domain/clock.js";
import type { ServiceState } from "./domain/types.js";
import type { Actor } from "./domain/types.js";

const STATE_FILE = process.env.STATE_FILE ?? ".runtime/state.json";

const clock = systemClock;
const persisted = loadState(STATE_FILE);
const store = new DomainStore(clock, persisted);
const decisions = new DecisionService(store, clock);
const queries = new QueryService(() => store.snapshot(), clock);

async function seed(): Promise<void> {
  if (Object.keys(store.snapshot().specimens).length > 0) return;
  const admin: Actor = { userId: "admin", roles: ["admin"] };
  await decisions.createSpecimen(admin, {
    id: "SPM-FOSSIL-01",
    code: "PAL-2026-0007",
    name: "稀有完整古鱼类模式标本",
    zones: [
      { id: "Z-REINFORCED", name: "已加固围岩区", reinforced: true, initialMassMg: 2000 },
      { id: "Z-UNREINFORCED", name: "仅存未加固区域", reinforced: false, initialMassMg: 800 },
    ],
  });
  const roster: Array<[string, string, string | undefined, boolean, string[], string[]]> = [
    ["rv-li", "李委员（古甲大学）", "ORG-GJD", false, [], []],
    ["rv-wang", "王委员（古甲大学）", "ORG-GJD", false, [], []],
    ["rv-chen", "陈委员（地层学院）", "ORG-DC", false, [], []],
    ["rv-zhao", "赵委员（新生代所）", "ORG-XSD", false, [], []],
    ["rv-sun", "孙主任（馆方）", undefined, true, [], ["ORG-GJD"]],
  ];
  for (const [id, name, orgId, isDirector, conflictUserIds, conflictOrgIds] of roster) {
    await decisions.upsertReviewer(admin, {
      id,
      name,
      ...(orgId !== undefined ? { orgId } : {}),
      isDirector,
      conflictUserIds,
      conflictOrgIds,
    });
  }
  process.stdout.write("seed: 已写入标本 SPM-FOSSIL-01 与 5 名委员\n");
}

await seed();

const port = Number.parseInt(process.env.PORT ?? "8000", 10);
const host = process.env.HOST ?? "0.0.0.0";
const server = createApp({ decisions, queries });

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`${signal}: 保存状态到 ${STATE_FILE}\n`);
  server.close(() => {
    try {
      saveState(store, STATE_FILE);
    } catch (error) {
      process.stderr.write(`状态保存失败: ${(error as Error).message}\n`);
    }
    process.exit(0);
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(port, host, () => {
  process.stdout.write(`service listening on ${host}:${port}\n`);
});

export type { ServiceState };
