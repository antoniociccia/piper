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
