import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';

import type { PGlite } from '@electric-sql/pglite';

interface SourceRow {
  readonly source: string;
  readonly kind: string;
  readonly chunks: number;
  readonly last_ingest: string;
}

interface KindAgg {
  readonly kind: string;
  readonly sources: number;
  readonly chunks: number;
}

export interface MemoryViewerProps {
  readonly db: PGlite;
  readonly onClose: () => void;
}

type Tab = 'overview' | 'sources';

export function MemoryViewer({ db, onClose }: MemoryViewerProps): JSX.Element {
  const [tab, setTab] = useState<Tab>('overview');
  const [kindAgg, setKindAgg] = useState<readonly KindAgg[] | null>(null);
  const [sources, setSources] = useState<readonly SourceRow[] | null>(null);
  const [selected, setSelected] = useState(0);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    try {
      const a = await db.query<KindAgg>(
        `SELECT kind,
                count(DISTINCT source)::int AS sources,
                count(*)::int               AS chunks
           FROM rag_documents
          GROUP BY kind
          ORDER BY kind`,
      );
      const s = await db.query<SourceRow>(
        `SELECT source, kind, count(*)::int AS chunks,
                max(created_at)::text       AS last_ingest
           FROM rag_documents
          GROUP BY source, kind
          ORDER BY max(created_at) DESC NULLS LAST`,
      );
      setKindAgg(a.rows);
      setSources(s.rows);
    } catch (err) {
      setStatusMsg(`error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function deleteSelectedSource(): Promise<void> {
    if (sources === null) return;
    const row = sources[selected];
    if (row === undefined) return;
    try {
      await db.query(`DELETE FROM rag_documents WHERE source = $1`, [row.source]);
      setStatusMsg(`deleted ${row.chunks} chunks from "${row.source}"`);
      await refresh();
    } catch (err) {
      setStatusMsg(`delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  useInput((input, key) => {
    // Esc / Enter / q all close the viewer — any of these intentions should
    // get the user back to the prompt. Enter is the most natural since
    // there's nothing to "submit" in this overlay.
    if (key.escape || key.return || input === 'q') {
      onClose();
      return;
    }
    if (key.tab) {
      setTab((t) => (t === 'overview' ? 'sources' : 'overview'));
      setSelected(0);
      return;
    }
    if (tab === 'sources' && sources !== null && sources.length > 0) {
      if (key.upArrow) {
        setSelected((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setSelected((i) => Math.min(sources.length - 1, i + 1));
        return;
      }
      if (input === 'd') {
        void deleteSelectedSource();
        return;
      }
    }
    if (input === 'r') {
      void refresh();
      setStatusMsg('refreshed');
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Box>
        <Text bold color="magenta">PIPER memory</Text>
        <Text dimColor> · Tab: switch view · r: refresh · Esc/Enter/q: close</Text>
      </Box>
      <Box marginTop={1}>
        {tab === 'overview' ? (
          <Text color="cyan" bold>[ Overview ]</Text>
        ) : (
          <Text dimColor>[ Overview ]</Text>
        )}
        <Text dimColor>  </Text>
        {tab === 'sources' ? (
          <Text color="cyan" bold>[ Sources ]</Text>
        ) : (
          <Text dimColor>[ Sources ]</Text>
        )}
      </Box>

      {tab === 'overview' && (
        <Box flexDirection="column" marginTop={1}>
          {kindAgg === null ? (
            <Text dimColor>loading…</Text>
          ) : kindAgg.length === 0 ? (
            <Text dimColor>no knowledge ingested yet. Drop markdown into docs/runbooks/ or docs/decisions/.</Text>
          ) : (
            kindAgg.map((k) => (
              <Box key={k.kind}>
                <Text color="green" bold>  {k.kind.padEnd(18)}</Text>
                <Text>{`${k.sources} source${k.sources === 1 ? '' : 's'}`.padEnd(14)}</Text>
                <Text dimColor>{`${k.chunks} chunk${k.chunks === 1 ? '' : 's'}`}</Text>
              </Box>
            ))
          )}
          <Box marginTop={1}>
            <Text dimColor>Kinds:</Text>
            <Text dimColor>  </Text>
            <Text dimColor>runbook = docs/runbooks/* · adr = docs/decisions/* · session-summary = /session-report · solved-case = /annex</Text>
          </Box>
        </Box>
      )}

      {tab === 'sources' && (
        <Box flexDirection="column" marginTop={1}>
          {sources === null ? (
            <Text dimColor>loading…</Text>
          ) : sources.length === 0 ? (
            <Text dimColor>no sources ingested yet.</Text>
          ) : (
            <>
              <Box>
                <Text dimColor>↑↓ to pick · d: delete source · Esc/Enter/q: close</Text>
              </Box>
              {sources.slice(0, 15).map((s, i) => {
                const active = i === selected;
                const label = active ? '▸' : ' ';
                return (
                  <Box key={s.source}>
                    <Text color={active ? 'cyan' : 'green'} bold={active}>
                      {label} [{s.kind}]
                    </Text>
                    <Text>{` ${s.source}`}</Text>
                    <Text dimColor>{`  ${s.chunks} chunks`}</Text>
                  </Box>
                );
              })}
              {sources.length > 15 && (
                <Text dimColor>{`… ${sources.length - 15} more not shown`}</Text>
              )}
            </>
          )}
        </Box>
      )}

      {statusMsg !== null && (
        <Box marginTop={1}>
          <Text color="yellow">{statusMsg}</Text>
        </Box>
      )}
    </Box>
  );
}
