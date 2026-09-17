/** 标识与时间工具，集中在此便于测试注入。 */

let counter = 0;

/** 进程内短随机标识（时间戳 + 计数 + 随机段），重启后仍以时间前缀去重。 */
export function newId(prefix: string, now: Date): string {
  counter = (counter + 1) % 0xffffff;
  const rand = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0");
  return `${prefix}_${now.getTime().toString(36)}${counter
    .toString(16)
    .padStart(4, "0")}${rand}`;
}

export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

/** ISO 字符串，去掉毫秒便于对账。 */
export function iso(date: Date): string {
  return date.toISOString();
}

/** 在给定日期上增加天数。 */
export function plusDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/** 在给定日期上增加自然月（用于保密期限）。 */
export function plusMonths(date: Date, months: number): Date {
  const result = new Date(date);
  const day = result.getDate();
  result.setMonth(result.getMonth() + months);
  // 月末溢出（如 1/31 + 1 月）回退到当月最后一天。
  if (result.getDate() < day) result.setDate(0);
  return result;
}
