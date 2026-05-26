import { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';

import type { OpenRouterModel } from '../models/openrouter-catalog.ts';
import { fetchOpenRouterModels } from '../models/openrouter-catalog.ts';
import type { LocalProviderProbe } from '../models/local-providers.ts';
import { probeAllLocalProviders } from '../models/local-providers.ts';

export type ModelSelection =
  | {
      readonly kind: 'local';
      readonly provider: 'ollama' | 'lmstudio' | 'llamacpp' | 'vllm';
      readonly host: string;
      readonly port: number;
      readonly model: string;
    }
  | {
      readonly kind: 'openrouter';
      readonly model: string;
      readonly contextLength: number;
      readonly inputUsdPerMtok: number;
      readonly outputUsdPerMtok: number;
      readonly toolCalling: boolean;
    };

interface Item {
  readonly label: string;
  readonly hint: string;
  readonly selection: ModelSelection;
}

export interface ModelPickerProps {
  readonly onSelect: (sel: ModelSelection) => void;
  readonly onCancel: () => void;
  /** Optional pre-fetched catalogue to avoid re-fetching. */
  readonly initialOpenRouterModels?: readonly OpenRouterModel[];
  readonly openRouterApiKey?: string;
}

type Tab = 'local' | 'openrouter';

function formatPrice(usdPerMtok: number): string {
  if (usdPerMtok === 0) return 'free';
  if (usdPerMtok >= 1) return `$${usdPerMtok.toFixed(2)}/Mtok`;
  return `$${usdPerMtok.toFixed(3)}/Mtok`;
}

function formatContext(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M ctx`;
  if (n >= 1000) return `${Math.round(n / 1000)}k ctx`;
  return `${n} ctx`;
}

export function ModelPicker({
  onSelect,
  onCancel,
  initialOpenRouterModels,
  openRouterApiKey,
}: ModelPickerProps): JSX.Element {
  const [tab, setTab] = useState<Tab>('openrouter');
  const [selected, setSelected] = useState(0);
  const [filter, setFilter] = useState('');
  const [localProbes, setLocalProbes] = useState<readonly LocalProviderProbe[] | null>(null);
  const [openRouterModels, setOpenRouterModels] = useState<readonly OpenRouterModel[] | null>(
    initialOpenRouterModels ?? null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (localProbes === null) {
      void probeAllLocalProviders().then(setLocalProbes).catch(() => setLocalProbes([]));
    }
    if (openRouterModels === null) {
      void fetchOpenRouterModels({
        ...(openRouterApiKey === undefined ? {} : { apiKey: openRouterApiKey }),
      })
        .then(setOpenRouterModels)
        .catch((err: unknown) => {
          setLoadError(err instanceof Error ? err.message : 'failed to load OpenRouter catalog');
          setOpenRouterModels([]);
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const localItems: readonly Item[] = useMemo(() => {
    if (localProbes === null) return [];
    const out: Item[] = [];
    for (const probe of localProbes) {
      if (!probe.reachable) continue;
      for (const m of probe.models) {
        out.push({
          label: `${probe.config.id} · ${m}`,
          hint: `localhost:${probe.config.port}`,
          selection: {
            kind: 'local',
            provider: probe.config.id,
            host: probe.config.host,
            port: probe.config.port,
            model: m,
          },
        });
      }
    }
    return out;
  }, [localProbes]);

  const openRouterItems: readonly Item[] = useMemo(() => {
    if (openRouterModels === null) return [];
    const filterLower = filter.toLowerCase();
    return openRouterModels
      .filter(
        (m) =>
          filterLower === '' ||
          m.id.toLowerCase().includes(filterLower) ||
          m.name.toLowerCase().includes(filterLower),
      )
      .map((m) => ({
        label: m.name,
        hint: `${m.id}  ·  ${formatPrice(m.inputUsdPerMtok)} in / ${formatPrice(m.outputUsdPerMtok)} out  ·  ${formatContext(m.contextLength)}  ·  ${m.toolCalling ? 'tools ✓' : 'tools ✗'}`,
        selection: {
          kind: 'openrouter',
          model: m.id,
          contextLength: m.contextLength,
          inputUsdPerMtok: m.inputUsdPerMtok,
          outputUsdPerMtok: m.outputUsdPerMtok,
          toolCalling: m.toolCalling,
        },
      }));
  }, [openRouterModels, filter]);

  const items = tab === 'local' ? localItems : openRouterItems;
  const VIEWPORT = 12;
  // Window over the items list — slides as `selected` moves past either edge.
  const windowStart = Math.max(0, Math.min(items.length - VIEWPORT, selected - Math.floor(VIEWPORT / 2)));
  const visible = items.slice(windowStart, windowStart + VIEWPORT);
  const localSelected = selected - windowStart;

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.tab) {
      setTab((t) => (t === 'local' ? 'openrouter' : 'local'));
      setSelected(0);
      return;
    }
    if (key.upArrow) {
      setSelected((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((i) => Math.min(Math.max(0, items.length - 1), i + 1));
      return;
    }
    if (key.pageUp) {
      setSelected((i) => Math.max(0, i - VIEWPORT));
      return;
    }
    if (key.pageDown) {
      setSelected((i) => Math.min(Math.max(0, items.length - 1), i + VIEWPORT));
      return;
    }
    if (key.return) {
      const pick = items[selected];
      if (pick !== undefined) onSelect(pick.selection);
      return;
    }
    if (tab === 'openrouter') {
      if (key.backspace || key.delete) {
        setFilter((f) => f.slice(0, -1));
        setSelected(0);
        return;
      }
      if (input !== '' && !key.ctrl && !key.meta) {
        setFilter((f) => f + input);
        setSelected(0);
      }
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Box>
        <Text bold color="magenta">/model</Text>
        <Text dimColor> · Tab to switch tab · Esc to cancel</Text>
      </Box>
      <Box marginTop={1}>
        {tab === 'local' ? (
          <Text color="cyan" bold>[ Local{localItems.length === 0 ? '' : ` (${localItems.length})`} ]</Text>
        ) : (
          <Text dimColor>[ Local{localItems.length === 0 ? '' : ` (${localItems.length})`} ]</Text>
        )}
        <Text dimColor>  </Text>
        {tab === 'openrouter' ? (
          <Text color="cyan" bold>[ OpenRouter{openRouterItems.length === 0 ? '' : ` (${openRouterItems.length})`} ]</Text>
        ) : (
          <Text dimColor>[ OpenRouter{openRouterItems.length === 0 ? '' : ` (${openRouterItems.length})`} ]</Text>
        )}
      </Box>
      {tab === 'openrouter' && (
        <Box marginTop={1}>
          <Text dimColor>filter: </Text>
          <Text color="cyan">{filter}</Text>
          <Text inverse> </Text>
        </Box>
      )}
      <Box flexDirection="column" marginTop={1}>
        {visible.length === 0 ? (
          <Text dimColor>
            {tab === 'local'
              ? localProbes === null
                ? 'probing local providers…'
                : 'no local providers reachable (try ollama serve / lm studio / llama.cpp / vllm)'
              : openRouterModels === null
                ? 'loading OpenRouter catalog…'
                : loadError !== null
                  ? `error: ${loadError}`
                  : 'no models match the filter'}
          </Text>
        ) : (
          <>
            {visible.map((it, i) => (
              <Box key={`${tab}-${it.label}-${i}`}>
                {i === localSelected ? (
                  <Text color="cyan" bold>▸ {it.label}</Text>
                ) : (
                  <Text>  {it.label}</Text>
                )}
                <Text dimColor>  {it.hint}</Text>
              </Box>
            ))}
            {items.length > VIEWPORT && (
              <Box marginTop={1}>
                <Text dimColor>
                  {`showing ${windowStart + 1}–${Math.min(items.length, windowStart + VIEWPORT)} of ${items.length} · PgUp/PgDn to page · type to filter`}
                </Text>
              </Box>
            )}
          </>
        )}
      </Box>
    </Box>
  );
}
