import { render, type Instance } from 'ink';
import { createElement } from 'react';

import { BootLoader } from './BootLoader.tsx';

/**
 * Imperative controller for the BootLoader Ink instance.
 *
 * Replaces the boot-time `process.stderr.write` lines (asset download
 * progress, dim-change re-ingest, etc.) with a single mounted comic-bubble
 * loader that updates in place. When boot completes, call `hide()` to
 * unmount and clear the terminal before the main App mounts.
 *
 * Why a singleton: there is exactly one boot per process, and we want
 * subsequent `show()` calls to update the same component rather than spawn
 * a second Ink instance (which would corrupt the layout).
 */

let instance: Instance | null = null;
let currentMessage = '';
let currentDetail: string | undefined;

export function show(message: string, detail?: string): void {
  currentMessage = message;
  currentDetail = detail;
  const node = createElement(BootLoader, {
    message: currentMessage,
    ...(currentDetail === undefined ? {} : { detail: currentDetail }),
  });
  if (instance === null) {
    instance = render(node);
  } else {
    instance.rerender(node);
  }
}

export function update(message: string, detail?: string): void {
  // Convenience alias for show — semantically clearer at call sites that
  // mean "I'm progressing the loader, not starting it".
  show(message, detail);
}

export function hide(): void {
  if (instance === null) return;
  instance.unmount();
  instance.clear();
  instance = null;
  currentMessage = '';
  currentDetail = undefined;
}

const PROGRESS_BAR_WIDTH = 20;
const BYTES_PER_MB = 1_048_576;

/**
 * Format a download-progress detail line for the boot bubble:
 *
 *   downloading model_quantized.onnx  ██████████░░░░░░░░░░  50%  (60.0 / 120.0 MB)
 *
 * Falls back to the bare filename when sizes are unknown (some CDN responses
 * omit Content-Length, so transformers.js cannot report a total).
 */
export function formatDownloadProgress(file: string, loaded?: number, total?: number): string {
  if (loaded === undefined || total === undefined || total <= 0) {
    return `downloading ${file}`;
  }
  const ratio = Math.min(1, loaded / total);
  const filled = Math.round(ratio * PROGRESS_BAR_WIDTH);
  const bar = '█'.repeat(filled) + '░'.repeat(PROGRESS_BAR_WIDTH - filled);
  const pct = Math.floor(ratio * 100);
  const mb = (n: number): string => (n / BYTES_PER_MB).toFixed(1);
  return `downloading ${file}  ${bar}  ${pct}%  (${mb(loaded)} / ${mb(total)} MB)`;
}
