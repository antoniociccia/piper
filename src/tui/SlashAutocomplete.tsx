import { Box, Text } from 'ink';

import type { SlashCompletion } from './commands.ts';

export interface SlashAutocompleteProps {
  readonly completions: readonly SlashCompletion[];
  readonly selectedIndex: number;
}

export function SlashAutocomplete({
  completions,
  selectedIndex,
}: SlashAutocompleteProps): JSX.Element | null {
  if (completions.length === 0) return null;
  return (
    <Box flexDirection="column" marginLeft={2} marginY={0}>
      {completions.map((c, i) => {
        const active = i === selectedIndex;
        return (
          <Box key={c.command}>
            {active ? (
              <Text color="cyan" bold>
                ▸ {c.command}
              </Text>
            ) : (
              <Text>  {c.command}</Text>
            )}
            <Text dimColor>  {c.hint}</Text>
          </Box>
        );
      })}
      <Text dimColor>  Tab/Enter to insert · ↑↓ to cycle · Esc to dismiss</Text>
    </Box>
  );
}
