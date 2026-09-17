/**
 * 标本余量核算。
 *
 * 唯一事实来源：分区建档初始质量 + 历次切割记录的实际质量 + 生效中的预留。
 * 余量永远从这三者重算，纸面审批无法修改它：
 *   consumed = Σ 已登记切割的实际质量
 *   held     = Σ 生效中(held)预留质量
 *   available（实物余量）   = initial - consumed
 *   freeForReservation（可预占）= available - held
 *
 * “并发申请不能预占同一份材料”由存储层互斥锁 + canReserve 检查共同保证。
 */
import type { MaterialHold, ServiceState, Specimen, SpecimenZone } from "./types.js";
import { notFound } from "./errors.js";
import { RULES } from "./rules.js";

export function getSpecimen(state: ServiceState, specimenId: string): Specimen {
  const specimen = state.specimens[specimenId];
  if (!specimen) notFound(`标本 ${specimenId} 不存在`);
  return specimen;
}

export function getZone(state: ServiceState, specimenId: string, zoneId: string): SpecimenZone {
  const specimen = getSpecimen(state, specimenId);
  const zone = specimen.zones.find((item) => item.id === zoneId);
  if (!zone) notFound(`标本 ${specimenId} 上不存在分区 ${zoneId}`);
  return zone;
}

export function activeHolds(state: ServiceState, zoneId?: string): MaterialHold[] {
  return Object.values(state.holds).filter(
    (hold) => hold.status === "held" && (zoneId === undefined || hold.zoneId === zoneId),
  );
}

/** 历次切割在某分区实际消耗的质量（mg）。 */
export function consumedMassMg(state: ServiceState, zoneId: string): number {
  return state.cuttings
    .filter((cutting) => cutting.zoneId === zoneId)
    .reduce((sum, cutting) => sum + cutting.actualMassMg, 0);
}

/** 生效中的预占质量（mg）。 */
export function heldMassMg(state: ServiceState, zoneId: string): number {
  return activeHolds(state, zoneId).reduce((sum, hold) => sum + hold.massMg, 0);
}

export interface ZoneAvailability {
  specimenId: string;
  zoneId: string;
  zoneName: string;
  reinforced: boolean;
  initialMassMg: number;
  consumedMassMg: number;
  heldMassMg: number;
  /** 实物剩余质量（含已预占）。 */
  availableMassMg: number;
  /** 当前还能预占的质量。 */
  freeForReservationMg: number;
  safetyReserveMg: number;
  /** 扣除本次预占后是否仍保有安全库存。 */
  belowSafetyReserve: boolean;
}

export function zoneAvailability(
  state: ServiceState,
  specimenId: string,
  zoneId: string,
): ZoneAvailability {
  const zone = getZone(state, specimenId, zoneId);
  const consumed = consumedMassMg(state, zoneId);
  const held = heldMassMg(state, zoneId);
  const available = zone.initialMassMg - consumed;
  const free = available - held;
  return {
    specimenId,
    zoneId,
    zoneName: zone.name,
    reinforced: zone.reinforced,
    initialMassMg: zone.initialMassMg,
    consumedMassMg: consumed,
    heldMassMg: held,
    availableMassMg: available,
    freeForReservationMg: free,
    safetyReserveMg: RULES.safetyReserveMg,
    belowSafetyReserve: available < RULES.safetyReserveMg,
  };
}

/**
 * 判断在某分区再预占 massMg 是否可行（必须在存储互斥区内调用）。
 * 返回不可行原因，或 null 表示可行。
 */
export function reservationBlocker(
  state: ServiceState,
  specimenId: string,
  zoneId: string,
  massMg: number,
): string | null {
  const availability = zoneAvailability(state, specimenId, zoneId);
  if (availability.freeForReservationMg + 1e-9 < massMg) {
    return `insufficient_material: 分区 ${availability.zoneName} 可预占余量 ${availability.freeForReservationMg}mg 不足申请 ${massMg}mg（含其他在审预占）`;
  }
  return null;
}
