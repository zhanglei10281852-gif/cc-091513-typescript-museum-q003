import type {
  Application,
  DataState,
  Specimen,
  SpecimenZone,
  User,
} from "./types.js";

/**
 * 余量核算。
 *
 * 标本余量 = 初始质量 - 历次实际切割损耗 - 当前生效预占。
 * 已批准但尚未取样的额度处于 reserved 状态；拒绝、撤回、超时后释放。
 * 所有数字都可从切割记录与申请事件反向追溯。
 */
export interface BalanceBreakdown {
  specimenId: string;
  initialMassMg: number;
  consumedMg: number;
  reservedMg: number;
  availableMg: number;
  zones: ZoneBalance[];
  reservations: { applicationId: string; versionNo: number; massMg: number }[];
}

export interface ZoneBalance {
  zoneId: string;
  name: string;
  reinforced: boolean;
  initialMassMg: number;
  consumedMg: number;
  reservedMg: number;
  availableMg: number;
}

function isReserved(app: Application): boolean {
  // 已取样的批准申请：预占已转化为实际切割消耗，不能再计入预占。
  if (app.sampledAt !== null) return false;
  return app.state === "approved" || app.state === "reviewing";
}

export function computeBalance(
  state: DataState,
  specimenId: string,
  excludeApplicationId?: string,
): BalanceBreakdown {
  const specimen = state.specimens[specimenId];
  if (!specimen) throw new Error(`specimen_not_found: ${specimenId}`);

  const consumed = new Map<string, number>();
  let consumedTotal = 0;
  for (const app of Object.values(state.applications)) {
    if (app.specimenId !== specimenId || app.id === excludeApplicationId) continue;
    for (const c of app.cuttings) {
      consumed.set(c.zoneId, (consumed.get(c.zoneId) ?? 0) + c.actualMassMg);
      consumedTotal += c.actualMassMg;
    }
  }

  const reserved = new Map<string, number>();
  const reservations: BalanceBreakdown["reservations"] = [];
  for (const app of Object.values(state.applications)) {
    if (app.specimenId !== specimenId || app.id === excludeApplicationId) continue;
    if (!isReserved(app)) continue;
    const v = app.versions.find((x) => x.versionNo === app.currentVersionNo);
    if (!v) continue;
    reserved.set(v.zoneId, (reserved.get(v.zoneId) ?? 0) + v.plannedMassMg);
    reservations.push({
      applicationId: app.id,
      versionNo: v.versionNo,
      massMg: v.plannedMassMg,
    });
  }

  const zones: ZoneBalance[] = specimen.zones.map((z: SpecimenZone) => {
    const c = consumed.get(z.id) ?? 0;
    const r = reserved.get(z.id) ?? 0;
    return {
      zoneId: z.id,
      name: z.name,
      reinforced: z.reinforced,
      initialMassMg: z.initialMassMg,
      consumedMg: round3(c),
      reservedMg: round3(r),
      availableMg: round3(Math.max(0, z.initialMassMg - c - r)),
    };
  });

  return {
    specimenId,
    initialMassMg: specimen.initialMassMg,
    consumedMg: round3(consumedTotal),
    reservedMg: round3([...reserved.values()].reduce((a, b) => a + b, 0)),
    availableMg: round3(Math.max(0, specimen.initialMassMg - consumedTotal - sumReserved(reserved))),
    zones,
    reservations,
  };
}

function sumReserved(m: Map<string, number>): number {
  return [...m.values()].reduce((a, b) => a + b, 0);
}

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** 委员是否需要回避：同机构自动回避，或命中显式回避关系。 */
export function mustRecuse(
  state: DataState,
  reviewer: User,
  app: Application,
): { recuse: boolean; reason: string | null } {
  if (reviewer.id === app.applicantId) {
    return { recuse: true, reason: "本人申请" };
  }
  if (app.institutionId && reviewer.institutionId === app.institutionId) {
    return { recuse: true, reason: `与申请人同属机构 ${app.institutionId}` };
  }
  for (const r of state.recusals) {
    if (r.reviewerId !== reviewer.id) continue;
    const hitApplicant = r.applicantId !== null && r.applicantId === app.applicantId;
    const hitInstitution =
      r.institutionId !== null && r.institutionId === app.institutionId;
    if (hitApplicant || hitInstitution) {
      return { recuse: true, reason: r.reason };
    }
  }
  return { recuse: false, reason: null };
}
