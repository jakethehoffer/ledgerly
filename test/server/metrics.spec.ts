import { describe, it, expect } from 'vitest';
import { inMemoryMetrics, noopMetrics } from '../../src/server/metrics.js';

describe('inMemoryMetrics', () => {
  describe('inc', () => {
    it('defaults to a delta of 1', () => {
      const m = inMemoryMetrics();
      m.inc('foo');
      expect(m.render()).toContain('ledgerly_foo_total 1');
    });

    it('accepts an explicit delta with undefined labels', () => {
      const m = inMemoryMetrics();
      m.inc('foo', undefined, 5);
      expect(m.render()).toContain('ledgerly_foo_total 5');
    });

    it('accumulates across calls with the same label tuple', () => {
      const m = inMemoryMetrics();
      m.inc('foo');
      m.inc('foo');
      m.inc('foo', undefined, 3);
      expect(m.render()).toContain('ledgerly_foo_total 5');
    });

    it('keeps separate values per label tuple', () => {
      const m = inMemoryMetrics();
      m.inc('webhook_processed', { type: 'payout.paid' });
      m.inc('webhook_processed', { type: 'payout.paid' });
      m.inc('webhook_processed', { type: 'charge.succeeded' });
      const out = m.render();
      expect(out).toContain('ledgerly_webhook_processed_total{type="payout.paid"} 2');
      expect(out).toContain('ledgerly_webhook_processed_total{type="charge.succeeded"} 1');
    });

    it('treats different values for the same label keys as distinct tuples', () => {
      const m = inMemoryMetrics();
      m.inc('events', { type: 'a' });
      m.inc('events', { type: 'b' });
      const out = m.render();
      expect(out).toContain('ledgerly_events_total{type="a"} 1');
      expect(out).toContain('ledgerly_events_total{type="b"} 1');
    });

    it('produces a stable label key regardless of key insertion order', () => {
      const m = inMemoryMetrics();
      m.inc('events', { a: '1', b: '2' });
      m.inc('events', { b: '2', a: '1' });
      const out = m.render();
      // Only one tuple should exist, with value 2.
      expect(out).toContain('ledgerly_events_total{a="1",b="2"} 2');
    });
  });

  describe('setGauge', () => {
    it('overwrites previous values rather than accumulating', () => {
      const m = inMemoryMetrics();
      m.setGauge('queue_depth', 5);
      m.setGauge('queue_depth', 12);
      m.setGauge('queue_depth', 3);
      const out = m.render();
      expect(out).toContain('ledgerly_queue_depth 3');
      expect(out).not.toContain('ledgerly_queue_depth 12');
    });

    it('keeps separate entries for distinct label tuples', () => {
      const m = inMemoryMetrics();
      m.setGauge('queue_depth', 10, { kind: 'pending' });
      m.setGauge('queue_depth', 2, { kind: 'failed' });
      const out = m.render();
      expect(out).toContain('ledgerly_queue_depth{kind="pending"} 10');
      expect(out).toContain('ledgerly_queue_depth{kind="failed"} 2');
    });
  });

  describe('render', () => {
    it('emits a # TYPE counter line for each counter name', () => {
      const m = inMemoryMetrics();
      m.inc('foo');
      m.inc('bar', { x: 'y' });
      const out = m.render();
      expect(out).toContain('# TYPE ledgerly_foo_total counter');
      expect(out).toContain('# TYPE ledgerly_bar_total counter');
    });

    it('emits a # TYPE gauge line for each gauge name without a _total suffix', () => {
      const m = inMemoryMetrics();
      m.setGauge('queue_depth', 7);
      const out = m.render();
      expect(out).toContain('# TYPE ledgerly_queue_depth gauge');
      expect(out).not.toContain('ledgerly_queue_depth_total');
    });

    it('returns an empty string when no metrics have been recorded', () => {
      expect(inMemoryMetrics().render()).toBe('');
    });

    it('escapes backslash, double quote, and newline in label values', () => {
      const m = inMemoryMetrics();
      m.inc('events', { detail: 'a"b\\c\nd' });
      const out = m.render();
      // Expected serialization: "a\"b\\c\nd" (each special escaped).
      expect(out).toContain('ledgerly_events_total{detail="a\\"b\\\\c\\nd"} 1');
    });

    it('respects a custom namespace prefix', () => {
      const m = inMemoryMetrics({ namespace: 'myapp' });
      m.inc('foo');
      m.setGauge('bar', 9);
      const out = m.render();
      expect(out).toContain('# TYPE myapp_foo_total counter');
      expect(out).toContain('myapp_foo_total 1');
      expect(out).toContain('# TYPE myapp_bar gauge');
      expect(out).toContain('myapp_bar 9');
    });

    it('preserves stable iteration order (counters first, then gauges, insertion order)', () => {
      const m = inMemoryMetrics();
      m.inc('alpha');
      m.inc('beta');
      m.setGauge('gamma', 1);
      m.setGauge('delta', 2);

      const first = m.render();
      const second = m.render();
      // Two consecutive renders should produce byte-identical output.
      expect(second).toBe(first);

      // Counters should come before gauges, and within each section the
      // order should match insertion order.
      const lines = first.trim().split('\n');
      const alphaTypeIdx = lines.indexOf('# TYPE ledgerly_alpha_total counter');
      const betaTypeIdx = lines.indexOf('# TYPE ledgerly_beta_total counter');
      const gammaTypeIdx = lines.indexOf('# TYPE ledgerly_gamma gauge');
      const deltaTypeIdx = lines.indexOf('# TYPE ledgerly_delta gauge');
      expect(alphaTypeIdx).toBeGreaterThanOrEqual(0);
      expect(betaTypeIdx).toBeGreaterThan(alphaTypeIdx);
      expect(gammaTypeIdx).toBeGreaterThan(betaTypeIdx);
      expect(deltaTypeIdx).toBeGreaterThan(gammaTypeIdx);
    });

    it('ends each non-empty render with a trailing newline', () => {
      const m = inMemoryMetrics();
      m.inc('foo');
      expect(m.render().endsWith('\n')).toBe(true);
    });
  });
});

describe('noopMetrics', () => {
  it('renders an empty string regardless of recorded values', () => {
    const m = noopMetrics();
    m.inc('foo');
    m.inc('bar', { type: 'x' }, 5);
    m.setGauge('baz', 9);
    expect(m.render()).toBe('');
  });

  it('does not throw when called with or without optional args', () => {
    const m = noopMetrics();
    expect(() => {
      m.inc('foo');
      m.inc('foo', { type: 'x' });
      m.inc('foo', undefined, 7);
      m.setGauge('bar', 1);
      m.setGauge('bar', 1, { kind: 'a' });
    }).not.toThrow();
  });
});
