/** 测试共用的可控时钟与时间工具。 */
import type { Clock } from "../src/domain/clock.js";
import { iso as domainIso, plusDays as domainPlusDays } from "../src/domain/clock.js";

export interface FakeClock extends Clock {
  current: Date;
  advanceDays(days: number): void;
}

export function fakeClock(base = new Date("2026-09-01T00:00:00.000Z")): FakeClock {
  const clock = (() => clock.current) as FakeClock;
  clock.current = base;
  clock.advanceDays = (days: number) => {
    clock.current = domainPlusDays(clock.current, days);
  };
  return clock;
}

export const iso = domainIso;
export const plusDays = domainPlusDays;
