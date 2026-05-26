import { ReportBlock } from './ReportBlock.tsx';

interface Props {
  readonly markdown: string;
  readonly verified: boolean | undefined;
  readonly streaming?: boolean;
}

/**
 * Inline answer renderer for the scrollback. Delegates to ReportBlock so the
 * committed reply is character-position-identical to the streaming preview
 * in App.tsx — same one-▌-per-paragraph, same colour cycle, same wrap rules.
 *
 * The mascot is locked: green when verified, yellow when surfaced ungrounded.
 * The streaming variant (no lock, colour-cycling mascot) is only used by the
 * dynamic block in App.tsx and is never committed.
 */
export function Report({ markdown, verified, streaming }: Props): JSX.Element {
  const mascotColor = verified === false ? 'yellow' : 'green';
  return (
    <ReportBlock
      lines={markdown.split('\n')}
      withMascot
      {...(streaming === true ? {} : { mascotColor })}
    />
  );
}
