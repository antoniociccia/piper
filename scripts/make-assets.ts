/**
 * Generates the two raster assets the repo needs but cannot keep by hand:
 *
 *   docs/assets/piper-logo-640.png   the README/landing logo, resized from the
 *                                    1536px master (2.2 MB for a 320px slot)
 *   docs/assets/social-preview.png   1280x640 card for GitHub's social preview
 *                                    and every link unfurl on LinkedIn/X/Slack
 *
 * Run with:  bun run scripts/make-assets.ts
 *
 * Colours are lifted from docs/index.html so the card, the landing page and the
 * TUI read as one thing.
 */
import sharp from 'sharp';

const BG = '#070d0b';
const PANEL = '#0c1512';
const BORDER = '#1d2f27';
const INK = '#d7e8df';
const MUTED = '#7d9a8c';
const FAINT = '#54705f';
const GREEN = '#7ddc6a';
const CYAN = '#3ee6c4';
const YELLOW = '#e8c060';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

const W = 1280;
const H = 640;

const card = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="glow" cx="72%" cy="8%" r="62%">
      <stop offset="0%" stop-color="${CYAN}" stop-opacity="0.10"/>
      <stop offset="100%" stop-color="${CYAN}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glow2" cx="-6%" cy="104%" r="58%">
      <stop offset="0%" stop-color="${GREEN}" stop-opacity="0.07"/>
      <stop offset="100%" stop-color="${GREEN}" stop-opacity="0"/>
    </radialGradient>
    <pattern id="scan" width="4" height="4" patternUnits="userSpaceOnUse">
      <rect width="4" height="2" fill="#000" opacity="0.055"/>
    </pattern>
  </defs>

  <rect width="${W}" height="${H}" fill="${BG}"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <rect width="${W}" height="${H}" fill="url(#glow2)"/>

  <!-- left column -->
  <text x="72" y="104" font-family="${MONO}" font-size="19" letter-spacing="7"
        fill="${FAINT}">TERMINAL DEVOPS COPILOT</text>

  <text x="70" y="192" font-family="${MONO}" font-size="82" font-weight="700"
        letter-spacing="4" fill="${INK}">PIPER</text>

  <text x="72" y="268" font-family="${MONO}" font-size="35" font-weight="700"
        fill="${GREEN}">It cannot invent a command.</text>

  <text x="72" y="322" font-family="${MONO}" font-size="23" fill="${MUTED}">The model picks a typed action from a</text>
  <text x="72" y="356" font-family="${MONO}" font-size="23" fill="${MUTED}">fixed catalog. Your machine runs it.</text>
  <text x="72" y="390" font-family="${MONO}" font-size="23" fill="${MUTED}">Nothing mutates without your approval.</text>

  <!-- badges -->
  <g font-family="${MONO}" font-size="19">
    <rect x="72" y="440" width="176" height="42" rx="6" fill="${PANEL}" stroke="${BORDER}"/>
    <text x="92" y="467" fill="${CYAN}">Apache-2.0</text>
    <rect x="262" y="440" width="210" height="42" rx="6" fill="${PANEL}" stroke="${BORDER}"/>
    <text x="282" y="467" fill="${CYAN}">4B local model</text>
    <rect x="486" y="440" width="244" height="42" rx="6" fill="${PANEL}" stroke="${BORDER}"/>
    <text x="506" y="467" fill="${CYAN}">no API key needed</text>
  </g>

  <text x="72" y="556" font-family="${MONO}" font-size="20" fill="${FAINT}">
    github.com/antoniociccia/piper
  </text>

  <!-- terminal panel -->
  <g>
    <rect x="760" y="118" width="452" height="404" rx="10" fill="${PANEL}" stroke="${BORDER}" stroke-width="1.5"/>
    <rect x="760" y="118" width="452" height="38" rx="10" fill="#0a1210"/>
    <rect x="760" y="146" width="452" height="10" fill="#0a1210"/>
    <circle cx="784" cy="137" r="5.5" fill="#3a4a42"/>
    <circle cx="804" cy="137" r="5.5" fill="#3a4a42"/>
    <circle cx="824" cy="137" r="5.5" fill="#3a4a42"/>
    <text x="852" y="143" font-family="${MONO}" font-size="15" fill="${FAINT}">piper</text>

    <g font-family="${MONO}" font-size="16.5">
      <text x="784" y="196" fill="${GREEN}">&#8250;</text>
      <text x="806" y="196" fill="${INK}">why is staging slow?</text>

      <text x="784" y="238" fill="${FAINT}">planning...  3 actions from</text>
      <text x="784" y="262" fill="${FAINT}">the catalog</text>

      <text x="784" y="300" fill="${CYAN}">&#10003;</text>
      <text x="812" y="300" fill="${MUTED}">system.uptime</text>
      <text x="784" y="326" fill="${CYAN}">&#10003;</text>
      <text x="812" y="326" fill="${MUTED}">system.memory</text>
      <text x="784" y="352" fill="${CYAN}">&#10003;</text>
      <text x="812" y="352" fill="${MUTED}">docker.compose_ps</text>

      <text x="784" y="398" fill="${YELLOW}">redis exited (137) &#8212; OOM</text>
      <text x="784" y="422" fill="${YELLOW}">killed 3 days ago</text>
      <text x="784" y="446" fill="${FAINT}">[ev-4]</text>

      <text x="784" y="490" fill="${GREEN}">every claim cites its source</text>
    </g>
  </g>

  <rect width="${W}" height="${H}" fill="url(#scan)"/>
</svg>`;

await sharp(Buffer.from(card)).png({ compressionLevel: 9 }).toFile('docs/assets/social-preview.png');

// The master is 1536x1024; the README slot is 320px and the landing page's is
// smaller still. 640 covers both at 2x on a retina display.
await sharp('docs/assets/piper-logo.png')
  .resize({ width: 640 })
  .png({ compressionLevel: 9, palette: true })
  .toFile('docs/assets/piper-logo-640.png');

for (const f of ['docs/assets/social-preview.png', 'docs/assets/piper-logo-640.png']) {
  const bytes = (await Bun.file(f).arrayBuffer()).byteLength;
  const meta = await sharp(f).metadata();
  console.log(`${f}  ${meta.width}x${meta.height}  ${(bytes / 1024).toFixed(0)} KB`);
}
