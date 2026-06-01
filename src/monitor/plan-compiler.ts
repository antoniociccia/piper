// src/monitor/plan-compiler.ts
import type { Catalog } from '../actions/catalog.ts';
import type { ChatMessage } from '../models/types.ts';

import { parseWatchPlan, validateAgainstCatalog } from './plan-loader.ts';
import type { WatchPlan } from './types.ts';

/**
 * A compiler message is a plain system/user ChatMessage.
 * We re-export the alias so callers can import a named type from this module,
 * but the underlying type is identical to ChatMessage — no adapter needed in
 * the TUI wiring layer (Task 11).
 */
export type CompilerMessage = Pick<ChatMessage, 'role' | 'content'> & {
  readonly role: 'system' | 'user';
};

export interface CompileDeps {
  readonly catalog: Catalog;
  readonly environmentNames: readonly string[];
  /**
   * One LLM round-trip: messages in, assistant text out. The TUI (Task 11)
   * wires this to ModelClient with cost tracking. Injected as a plain function
   * so this module never touches the client directly.
   */
  readonly complete: (messages: readonly CompilerMessage[]) => Promise<string>;
}

export type CompileResult =
  | { readonly kind: 'ok'; readonly plan: WatchPlan }
  | { readonly kind: 'error'; readonly message: string };

// ── DSL reference embedded in the system prompt ──────────────────────────────

const DSL_REFERENCE = `Available expectation kinds (the ONLY valid values for expect.kind):
- exit_zero: command exits 0
- all_running: every container/pod/service in the parsed output is in "running" state
- max_percent { value }: highest NN% in output must be <= value
- min_count { value }: parsed item count (or non-empty stdout lines) >= value
- regex_match { pattern }: stdout matches the regex
- regex_absent { pattern }: stdout does NOT match the regex
- json_path_eq { path, value }: JSON output at dot-path equals value`;

// ── Message builder (exported for unit testing) ───────────────────────────────

/**
 * Build the messages to send to the LLM for plan compilation. Exported so
 * tests can inspect the message contents without calling the LLM.
 */
export function buildCompilerMessages(
  userRequest: string,
  catalog: Catalog,
  environmentNames: readonly string[],
): readonly CompilerMessage[] {
  const readActions = catalog
    .list({ tier: 'read' })
    .map((a) => `- ${a.name}: ${a.description}`)
    .join('\n');

  const envList = environmentNames.join(', ');

  const system = `You are PIPER's watch-plan compiler. You convert a user's monitoring request into a deterministic watch plan.

Rules:
- You may ONLY use the read-only actions listed below. Never invent action names.
- Output EXACTLY ONE fenced yaml block and nothing else after it.
- The yaml must have: name (kebab-case), description, environment, checks[].
- Each check: action, args (must satisfy that action's parameters), expect, every (e.g. "30s", "5m" — minimum 10s).
- Registered environments: ${envList}. Use one of these as the plan environment and in args.environment.

${DSL_REFERENCE}

Available read-only actions:
${readActions}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: userRequest },
  ];
}

// ── YAML extraction ───────────────────────────────────────────────────────────

// Case-insensitive: models occasionally emit ```YAML or ```Yaml fences.
const YAML_BLOCK = /```ya?ml\n([\s\S]*?)```/i;

function extractYaml(responseText: string): string | null {
  const match = YAML_BLOCK.exec(responseText);
  const inner = match?.[1];
  return inner === undefined ? null : inner.trim();
}

// ── Main compiler ─────────────────────────────────────────────────────────────

/**
 * Compile a natural-language monitoring request into a validated WatchPlan.
 *
 * Makes at most TWO LLM calls:
 *   1. Initial attempt.
 *   2. If parse/validation fails, one retry with the error message appended so
 *      the model can self-correct.
 *
 * The LLM is fully sandboxed: every candidate plan is run through
 * `validateAgainstCatalog` before being accepted, which enforces the read-only
 * gate deterministically regardless of what the model emits.
 *
 * Never throws — all error paths return `{ kind: 'error', message }`.
 */
export async function compileWatchPlan(
  userRequest: string,
  deps: CompileDeps,
): Promise<CompileResult> {
  const messages: CompilerMessage[] = [
    ...buildCompilerMessages(userRequest, deps.catalog, deps.environmentNames),
  ];

  let lastError = 'unknown error';

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let responseText: string;
    try {
      responseText = await deps.complete(messages);
    } catch (err) {
      // Fail fast on a thrown error: it is a transport/model problem, not a
      // model-output problem — retrying with the same messages would not help,
      // and the caller (TUI) is better placed to decide whether to re-run.
      return {
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      };
    }

    const yaml = extractYaml(responseText);

    if (yaml === null) {
      lastError = 'no yaml block found in the response';
    } else {
      try {
        // parseWatchPlan expects the markdown-with-frontmatter format:
        //   ---\n<yaml>\n---\n\n<body>
        // We wrap the extracted yaml in those delimiters. The body is the
        // user's original request, giving the diagnoser runbook context.
        const planText = `---\n${yaml}\n---\n\n# Watch request\n\n${userRequest}\n`;
        const plan = parseWatchPlan(planText, 'compiled');
        // Gate: validate all actions are read-tier and in the catalog.
        // This is always applied — there is no path that skips it.
        validateAgainstCatalog(plan, deps.catalog);
        return { kind: 'ok', plan };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    // First attempt failed — append the error and let the model retry once.
    if (attempt === 0) {
      messages.push({
        role: 'user',
        content: `That plan is invalid: ${lastError}. Produce a corrected yaml block following all the rules.`,
      });
    }
  }

  return {
    kind: 'error',
    message: `could not compile a valid plan after retry: ${lastError}`,
  };
}
