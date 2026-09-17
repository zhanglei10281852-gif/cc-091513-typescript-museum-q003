import { renameSync, writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import type { DataState } from "./types.js";
import { fail } from "./errors.js";

/**
 * JSON 文件存储 + 全局互斥队列。
 *
 * 所有改变额度/申请状态的命令都必须经过 mutate：Node 单线程内同步代码本身
 * 不会交错，但跨 await 的读改写需要互斥，防止两个并发申请同时通过额度校验
 * 而预占同一份材料。落盘采用临时文件 + rename 原子替换。
 */
export class Store {
  state: DataState;
  private readonly file: string;
  private last: Promise<unknown> = Promise.resolve();

  constructor(state: DataState, file: string) {
    this.state = state;
    this.file = file;
  }

  static load(file: string, initial: DataState): Store {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as DataState;
      return new Store(parsed, file);
    }
    const store = new Store(structuredClone(initial), file);
    store.persistSync();
    return store;
  }

  private persistSync(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state));
    renameSync(tmp, this.file);
  }

  /**
   * 串行执行变更任务，任务返回后才释放锁，保证额度校验-预占的原子性。
   * 任务抛错时回滚到执行前快照，避免失败命令污染内存状态。
   */
  async mutate<T>(job: () => T | Promise<T>): Promise<T> {
    const run = this.last.then(async () => {
      const snapshot = structuredClone(this.state);
      try {
        const result = await job();
        this.persistSync();
        return result;
      } catch (error) {
        this.state = snapshot;
        throw error;
      }
    });
    // 无论成败都放行队列。
    this.last = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export function requireSpecimen(state: DataState, specimenId: string) {
  const specimen = state.specimens[specimenId];
  if (!specimen) fail("not_found", `标本不存在: ${specimenId}`, 404);
  return specimen!;
}

export function requireUser(state: DataState, userId: string) {
  const user = state.users[userId];
  if (!user) fail("not_found", `用户不存在: ${userId}`, 404);
  return user!;
}
