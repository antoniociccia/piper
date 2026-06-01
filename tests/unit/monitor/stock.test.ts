import { describe, expect, test } from 'bun:test';

import { createCatalog } from '../../../src/actions/catalog.ts';
import { BUILTIN_ACTIONS } from '../../../src/actions/builtin/index.ts';
import { evaluateExpectation } from '../../../src/monitor/expectations.ts';
import { parseWatchPlan, validateAgainstCatalog } from '../../../src/monitor/plan-loader.ts';
import { instantiateStockPlan, STOCK_PLANS } from '../../../src/monitor/stock.ts';

function makeRealCatalog() {
  const catalog = createCatalog();
  for (const action of BUILTIN_ACTIONS) catalog.register(action);
  return catalog;
}

describe('monitor/stock — bundled plans', () => {
  test('there are exactly 3 stock plans with the expected names', () => {
    expect(STOCK_PLANS.map((p) => p.name).sort()).toEqual([
      'disk-and-memory',
      'docker-basics',
      'k8s-basics',
    ]);
  });

  test('every stock plan parses, validates against the real builtin catalog, and is read-tier only', () => {
    const catalog = makeRealCatalog();

    for (const stock of STOCK_PLANS) {
      const instantiated = instantiateStockPlan(stock.text, 'staging');
      const plan = parseWatchPlan(instantiated, 'stock');
      expect(plan.name).toBe(stock.name);
      expect(plan.runbook.length).toBeGreaterThan(50);
      // The gate validation must pass — stock plans are held to the same rules as user plans.
      expect(() => validateAgainstCatalog(plan, catalog)).not.toThrow();
    }
  });

  test('instantiateStockPlan replaces every __ENV__ placeholder', () => {
    for (const stock of STOCK_PLANS) {
      const instantiated = instantiateStockPlan(stock.text, 'my-prod-env');
      expect(instantiated).not.toContain('__ENV__');
      expect(instantiated).toContain('my-prod-env');
    }
  });

  test('stock plan checks have sensible intervals (>= 30s, <= 1h)', () => {
    for (const stock of STOCK_PLANS) {
      const plan = parseWatchPlan(instantiateStockPlan(stock.text, 'staging'), 'stock');
      for (const check of plan.checks) {
        expect(check.intervalMs).toBeGreaterThanOrEqual(30_000);
        expect(check.intervalMs).toBeLessThanOrEqual(3_600_000);
      }
    }
  });
});

describe('monitor/stock — disk-and-memory swap check semantics', () => {
  const HEALTHY_FREE = [
    '              total        used        free      shared  buff/cache   available',
    'Mem:           15Gi        4.2Gi       8.1Gi       512Mi      3.0Gi        10Gi',
    'Swap:         2.0Gi          0B       2.0Gi',
  ].join('\n');

  const SWAPPING_FREE = [
    '              total        used        free      shared  buff/cache   available',
    'Mem:           15Gi         14Gi       128Mi       512Mi      1.0Gi       256Mi',
    'Swap:         2.0Gi        1.5Gi       512Mi',
  ].join('\n');

  test('the swap expectation passes on a healthy host and fails on a swapping host', () => {
    const stockEntry = STOCK_PLANS.find((p) => p.name === 'disk-and-memory');
    expect(stockEntry).toBeDefined();
    if (stockEntry === undefined) return;

    const plan = parseWatchPlan(instantiateStockPlan(stockEntry.text, 'staging'), 'stock');
    const swapCheck = plan.checks.find((c) => c.name === 'memory-ok');
    expect(swapCheck).toBeDefined();
    if (swapCheck === undefined) return;

    const healthy = evaluateExpectation(swapCheck.expect, { stdout: HEALTHY_FREE, stderr: '', exitCode: 0 });
    expect(healthy.passed).toBe(true);

    const swapping = evaluateExpectation(swapCheck.expect, { stdout: SWAPPING_FREE, stderr: '', exitCode: 0 });
    expect(swapping.passed).toBe(false);
  });
});
