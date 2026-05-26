import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';

import type { SessionsRepo, SessionSummary } from '../memory/sessions.ts';

export interface SessionPickerProps {
  readonly sessionsRepo: SessionsRepo;
  readonly currentSessionId: string;
  readonly onSelect: (sessionId: string) => void;
  readonly onCancel: () => void;
}

function formatAge(date: Date): string {
  const ms = Date.now() - date.getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function SessionPicker({
  sessionsRepo,
  currentSessionId,
  onSelect,
  onCancel,
}: SessionPickerProps): JSX.Element {
  const [items, setItems] = useState<readonly SessionSummary[] | null>(null);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    void sessionsRepo
      .listRecent(15)
      .then((list) => setItems(list.filter((s) => s.id !== currentSessionId)))
      .catch(() => setItems([]));
  }, [sessionsRepo, currentSessionId]);

  const visible = items ?? [];

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow) {
      setSelected((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((i) => Math.min(Math.max(0, visible.length - 1), i + 1));
      return;
    }
    if (key.return) {
      const pick = visible[selected];
      if (pick !== undefined) onSelect(pick.id);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Box>
        <Text bold color="magenta">/resume</Text>
        <Text dimColor>  ↑↓ to pick · Enter to resume · Esc to cancel</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {items === null ? (
          <Text dimColor>loading sessions…</Text>
        ) : visible.length === 0 ? (
          <Text dimColor>no previous sessions to resume.</Text>
        ) : (
          visible.map((s, i) => {
            const label = s.title ?? `session ${s.id.slice(-8)}`;
            const hint = `${formatAge(s.lastActiveAt)} · ${s.messageCount} msg`;
            return (
              <Box key={s.id}>
                {i === selected ? (
                  <Text color="cyan" bold>▸ {label}</Text>
                ) : (
                  <Text>  {label}</Text>
                )}
                <Text dimColor>  {hint}</Text>
              </Box>
            );
          })
        )}
      </Box>
    </Box>
  );
}
