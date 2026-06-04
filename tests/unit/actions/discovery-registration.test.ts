import { describe, expect, test } from 'bun:test';

import { createCatalog } from '../../../src/actions/catalog.ts';
import { registerBuiltins } from '../../../src/actions/builtin/index.ts';

describe('discovery actions are registered', () => {
  const c = createCatalog();
  registerBuiltins(c);
  test('docker.compose_ls is in the catalog as read-tier', () => {
    expect(c.resolve('docker.compose_ls')?.tier).toBe('read');
  });
  test('discover.compose_files is in the catalog as read-tier', () => {
    expect(c.resolve('discover.compose_files')?.tier).toBe('read');
  });
  test('docker.compose_config is in the catalog as read-tier', () => {
    expect(c.resolve('docker.compose_config')?.tier).toBe('read');
  });
  test('docker.compose_logs is in the catalog as read-tier', () => {
    expect(c.resolve('docker.compose_logs')?.tier).toBe('read');
  });
});
