import { useState } from 'react';
import { Box, Text, useInput } from 'ink';

export type EmbeddingBackendChoice = 'wasm' | 'http' | 'openrouter' | 'none';

export interface EmbeddingBackendPickerProps {
  readonly onSelect: (choice: EmbeddingBackendChoice) => void;
  readonly hasOpenRouterKey: boolean;
}

interface Option {
  readonly value: EmbeddingBackendChoice;
  readonly label: string;
  readonly subtitle: string;
  readonly available: boolean;
  readonly unavailableReason?: string;
}

export function EmbeddingBackendPicker({
  onSelect,
  hasOpenRouterKey,
}: EmbeddingBackendPickerProps): JSX.Element {
  const options: readonly Option[] = [
    {
      value: 'wasm',
      label: 'WASM in-process (Recommended)',
      subtitle: 'multilingual-e5-small via transformers.js. Local, offline, zero setup. ~120MB downloaded once.',
      available: true,
    },
    {
      value: 'http',
      label: 'Local HTTP (Ollama / LM Studio / llama.cpp / vLLM)',
      subtitle: 'Use a local OpenAI-compatible embedding endpoint you already run. Detected at boot.',
      available: true,
    },
    {
      value: 'openrouter',
      label: 'OpenRouter (remote, paid)',
      subtitle: 'Cloud embeddings via OpenRouter. Costs ~$0.02/1M tokens. Sends your queries upstream.',
      available: hasOpenRouterKey,
      unavailableReason: 'requires openrouter_api_key in credentials.json',
    },
    {
      value: 'none',
      label: 'None — disable memory / RAG entirely',
      subtitle: 'No retrieval, no embedding, no memory.search action. PIPER runs lighter, no project knowledge base.',
      available: true,
    },
  ];

  const [selected, setSelected] = useState(0);

  useInput((_input, key) => {
    if (key.upArrow) {
      // skip unavailable ones going up
      for (let i = selected - 1; i >= 0; i -= 1) {
        if (options[i]?.available === true) {
          setSelected(i);
          return;
        }
      }
      return;
    }
    if (key.downArrow) {
      for (let i = selected + 1; i < options.length; i += 1) {
        if (options[i]?.available === true) {
          setSelected(i);
          return;
        }
      }
      return;
    }
    if (key.return) {
      const opt = options[selected];
      if (opt !== undefined && opt.available) onSelect(opt.value);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Box>
        <Text bold color="magenta">PIPER memory</Text>
        <Text dimColor>  ·  how should PIPER handle project knowledge (runbooks, ADRs, past sessions)?</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑↓ to choose · Enter to confirm. Stored in ~/.piper/credentials.json (you can edit later).</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {options.map((opt, i) => {
          const active = i === selected;
          const labelColor = !opt.available ? 'gray' : active ? 'cyan' : 'green';
          const marker = !opt.available ? '  ' : active ? '▸ ' : '  ';
          return (
            <Box key={opt.value} flexDirection="column" marginBottom={0}>
              <Box>
                <Text color={labelColor} bold={active && opt.available}>
                  {marker}
                  {opt.label}
                  {!opt.available ? '  (unavailable)' : ''}
                </Text>
              </Box>
              <Box marginLeft={4}>
                <Text dimColor>
                  {opt.subtitle}
                  {!opt.available && opt.unavailableReason !== undefined
                    ? `  — ${opt.unavailableReason}`
                    : ''}
                </Text>
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
