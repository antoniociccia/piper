import type { Action, Tier } from './types.ts';

export interface CatalogListFilter {
  readonly tier?: Tier;
}

export interface Catalog {
  register<Args>(action: Action<Args, unknown>): void;
  resolve(name: string): Action<unknown, unknown> | undefined;
  list(filter?: CatalogListFilter): readonly Action<unknown, unknown>[];
  size(): number;
}

export class DuplicateActionError extends Error {
  readonly actionName: string;
  constructor(actionName: string) {
    super(`duplicate action registration: ${actionName}`);
    this.name = 'DuplicateActionError';
    this.actionName = actionName;
  }
}

export function createCatalog(): Catalog {
  const map = new Map<string, Action<unknown, unknown>>();

  return {
    register(action) {
      const name = action.name;
      if (map.has(name)) {
        throw new DuplicateActionError(name);
      }
      map.set(name, action as Action<unknown, unknown>);
    },
    resolve(name) {
      return map.get(name);
    },
    list(filter) {
      const all = [...map.values()];
      if (filter?.tier === undefined) return all;
      const tier = filter.tier;
      return all.filter((a) => a.tier === tier);
    },
    size() {
      return map.size;
    },
  };
}
