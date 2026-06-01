import { useState } from 'react';
import { Box, Text, useInput } from 'ink';

import type { CheckOutcome, WatchPlan } from '../monitor/types.ts';

import { AlienFace } from './AlienFace.tsx';

export interface WatchAnomalyView {
  readonly checkName: string;
  readonly consecutiveFailures: number;
  readonly atMs: number;
}

export interface WatchPanelProps {
  readonly plan: WatchPlan;
  /** Latest outcome per check name. */
  readonly lastOutcomes: ReadonlyMap<string, CheckOutcome>;
  /** Recent pass/fail history per check (oldest→newest, capped). */
  readonly history: ReadonlyMap<string, readonly boolean[]>;
  /** Anomalies, newest first. */
  readonly anomalies: readonly WatchAnomalyView[];
  /** Diagnosis report markdown per check, when ready. */
  readonly diagnoses: ReadonlyMap<string, string>;
  /** Checks with a diagnosis in flight. */
  readonly diagnosing: ReadonlySet<string>;
  readonly onStop: () => void;
  /** Surface a ready diagnosis report in the chat feed. */
  readonly onViewDiagnosis: (checkName: string) => void;
}

function sparkline(history: readonly boolean[]): string {
  if (history.length === 0) return '·';
  return history.map((pass) => (pass ? '·' : '✗')).join('');
}

function outcomeColor(outcome: CheckOutcome | undefined): string {
  if (outcome === undefined) return 'gray';
  if (outcome.kind === 'pass') return 'green';
  if (outcome.kind === 'expectation-failed') return 'red';
  return 'yellow';
}

function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

export function WatchPanel(props: WatchPanelProps): JSX.Element {
  const { plan, lastOutcomes, history, anomalies, diagnoses, diagnosing } = props;
  const [selected, setSelected] = useState(0);
  const checks = plan.checks;

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      props.onStop();
      return;
    }
    if (key.upArrow) {
      setSelected((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((i) => Math.min(checks.length - 1, i + 1));
      return;
    }
    if (key.return || input === 'd') {
      const check = checks[selected];
      if (check !== undefined && diagnoses.has(check.name)) {
        props.onViewDiagnosis(check.name);
      }
      return;
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box>
        <AlienFace busy bold />
        <Text bold color="cyan">{`  watch · ${plan.name}`}</Text>
        <Text dimColor>{`  on ${plan.environment}`}</Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {checks.map((check, i) => {
          const outcome = lastOutcomes.get(check.name);
          const active = i === selected;
          const hasDiag = diagnoses.has(check.name);
          const detail = outcome === undefined ? 'waiting for first run…' : truncate(outcome.detail, 44);
          return (
            <Box key={check.name}>
              <Text color={active ? 'cyan' : 'gray'} bold={active}>
                {active ? '▸ ' : '  '}
              </Text>
              <Text color={outcomeColor(outcome)} bold>
                {check.name.padEnd(20)}
              </Text>
              <Text dimColor>{sparkline(history.get(check.name) ?? []).padEnd(22)}</Text>
              <Text dimColor>{detail}</Text>
              {hasDiag && <Text color="magenta"> ⏎ diag</Text>}
            </Box>
          );
        })}
      </Box>

      {anomalies.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="red">anomalies</Text>
          {anomalies.slice(0, 5).map((a, i) => {
            const status = diagnoses.has(a.checkName)
              ? 'diagnosis ready (⏎ to view)'
              : diagnosing.has(a.checkName)
                ? 'diagnosing…'
                : 'notified';
            return (
              <Box key={`${a.checkName}-${a.atMs}-${i}`}>
                <Text color="red">{`  ${a.checkName.padEnd(20)}`}</Text>
                <Text dimColor>{`${a.consecutiveFailures}× fail · ${status}`}</Text>
              </Box>
            );
          })}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>↑↓ select · ⏎/d view diagnosis · q/Esc stop watch</Text>
      </Box>
    </Box>
  );
}
