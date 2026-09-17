import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { latestRuleVersion } from "./domain/rules.js";
import { Store } from "./domain/store.js";
import { SamplingService } from "./domain/service.js";
import type { DataState } from "./domain/types.js";

const here = dirname(fileURLToPath(import.meta.url));
/** dist/src/bootstrap.js → ../../reference；源码同构（src/bootstrap.ts → ../reference 不存在，故用 dist 口径）。 */
export const referenceDir = process.env.SAMPLING_REFERENCE_DIR ?? join(here, "..", "..", "reference");
export const defaultStateFile =
  process.env.SAMPLING_STATE_FILE ?? join(here, "..", "..", ".runtime", "state.json");

export function initialState(): DataState {
  const raw = JSON.parse(
    readFileSync(join(referenceDir, "seed.json"), "utf8"),
  ) as Pick<DataState, "users" | "specimens" | "recusals">;
  return {
    seq: 0,
    currentRuleVersion: latestRuleVersion(),
    users: raw.users,
    specimens: raw.specimens,
    recusals: raw.recusals,
    applications: {},
  };
}

export interface Context {
  store: Store;
  service: SamplingService;
}

export function createContext(stateFile: string = defaultStateFile): Context {
  const store = Store.load(stateFile, initialState());
  return { store, service: new SamplingService(store) };
}
