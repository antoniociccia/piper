import { z } from 'zod';

import type { Action } from '../actions/types.ts';
import type { Catalog } from '../actions/catalog.ts';
import type { ToolDefinition } from '../models/types.ts';

export function actionToToolDef(action: Action<unknown, unknown>): ToolDefinition {
  const jsonSchema = z.toJSONSchema(action.argsSchema);
  return {
    name: action.name,
    description: action.description,
    parameters: jsonSchema,
  };
}

export function catalogToToolDefs(catalog: Catalog): readonly ToolDefinition[] {
  return catalog.list().map(actionToToolDef);
}
