import { Box, Text } from 'ink';

export function Help(): JSX.Element {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">PIPER — help</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>Type any question for the agent to diagnose, or use a slash command:</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>Environments</Text>
        <Text>  /env add &lt;name&gt; &lt;user@host[:port]&gt; [--key &lt;path&gt;] [--desc "..."] [--tag a,b]</Text>
        <Text>  /env list</Text>
        <Text>  /env remove &lt;name&gt;</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>Session</Text>
        <Text>  /help    show this screen (press any key to return)</Text>
        <Text>  /save [file.md]  export the last report
  /session-report [file.md]  build a comprehensive recap of the whole session
                              (also indexed for RAG so future sessions can recall it)</Text>
        <Text>  /quit    exit PIPER</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          Read-only diagnostics. PIPER never mutates without your explicit approval.
        </Text>
      </Box>
    </Box>
  );
}
