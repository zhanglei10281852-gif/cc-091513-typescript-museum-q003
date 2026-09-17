/**
 * 事件溯源式内存存储 + 进程内互斥。
 *
 * 所有写操作都经过 mutate()：同一时刻只有一个变更在执行，
 * “读取余量 → 判定可预占 → 写入预留”因此是原子的，
 * 两个并发送审不可能同时预占同一份材料。
 *
 * 每次变更追加一条不可变事件，管理员视图沿事件即可追溯全部决定；
 * 状态可整体序列化到 .runtime/state.json，启动时回放恢复。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ServiceState } from "./types.js";
import type { Clock } from "./clock.js";
import { iso } from "./clock.js";

export interface DomainEvent {
  id: number;
  at: string;
  actorId: string;
  type: string;
  payload: unknown;
}

export interface PersistedState {
  state: ServiceState;
  events: DomainEvent[];
}

function emptyState(): ServiceState {
  return {
    specimens: {},
    reviewers: {},
    applications: {},
    holds: {},
    cuttings: [],
    counters: { application: 0, approval: 0 },
  };
}

export class DomainStore {
  private state: ServiceState;
  readonly events: DomainEvent[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private eventSeq = 0;

  constructor(
    private readonly clock: Clock,
    initial?: PersistedState,
  ) {
    this.state = initial ? structuredClone(initial.state) : emptyState();
    if (initial) {
      this.events.push(...structuredClone(initial.events));
      this.eventSeq = this.events.reduce((max, event) => Math.max(max, event.id), 0);
    }
  }

  /** 在互斥区内读取并变更状态，同时落一条审计事件。 */
  async mutate<T>(
    actorId: string,
    type: string,
    fn: (state: ServiceState) => T,
    payload?: unknown,
  ): Promise<T> {
    const run = this.chain.then(() => {
      const result = fn(this.state);
      this.eventSeq += 1;
      this.events.push({
        id: this.eventSeq,
        at: iso(this.clock()),
        actorId,
        type,
        payload: payload ?? null,
      });
      return result;
    });
    // 保持链式执行，即使本次变更抛错也不阻塞后续变更。
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 只读快照（深拷贝，调用方无法篡改内部状态）。 */
  snapshot(): ServiceState {
    return structuredClone(this.state);
  }

  /** 供领域服务在同一互斥区内使用的直接引用（仅限 mutate 回调内）。 */
  liveState(): ServiceState {
    return this.state;
  }

  toJSON(): PersistedState {
    return { state: this.snapshot(), events: structuredClone(this.events) };
  }
}

/** 简易 JSON 持久化（启动加载、退出前/按需保存）。 */
export function saveState(store: DomainStore, file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(store.toJSON(), null, 2), "utf8");
}

export function loadState(file: string): PersistedState | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as PersistedState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
