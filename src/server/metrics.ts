/**
 * Metric labels as a flat object. Keys and values are strings (numbers are
 * stringified at render time). Use sparingly — high-cardinality labels (like
 * customer ID) explode storage and break Prometheus scrapers.
 */
export type Labels = Readonly<Record<string, string | number>>;

/**
 * Minimal metrics contract. Downstream consumers can implement this against
 * prom-client, OpenTelemetry, statsd, or any custom backend.
 *
 * `inc` adds to a counter (monotonically increasing). Counters with labels
 * keep separate values per label tuple.
 *
 * `setGauge` overwrites a gauge (current value, can go up or down). Gauges
 * with labels behave the same as counters w.r.t. label tuples.
 *
 * `render` returns the current state in Prometheus text exposition format.
 * https://prometheus.io/docs/instrumenting/exposition_formats/
 */
export interface Metrics {
  inc(name: string, labels?: Labels, value?: number): void;
  setGauge(name: string, value: number, labels?: Labels): void;
  render(): string;
}

export interface InMemoryMetricsOptions {
  /** Namespace prefix for all metric names. Default 'ledgerly'. */
  readonly namespace?: string;
}

/**
 * Default in-memory metrics backend. Renders the recorded counter and gauge
 * state in Prometheus text exposition format (v0.0.4). Suitable for a single
 * webhook-receiver process; multi-process deployments need a shared backend
 * (statsd, push gateway) or per-process scraping.
 */
export function inMemoryMetrics(options: InMemoryMetricsOptions = {}): Metrics {
  const namespace = options.namespace ?? 'ledgerly';
  // Maps name -> labelTupleKey -> value. Empty labels use key ''.
  const counters = new Map<string, Map<string, number>>();
  const gauges = new Map<string, Map<string, number>>();

  function labelKey(labels?: Labels): string {
    if (!labels) return '';
    const keys = Object.keys(labels).sort();
    if (keys.length === 0) return '';
    return keys.map((k) => `${k}=${String(labels[k])}`).join('|');
  }

  function bump(
    map: Map<string, Map<string, number>>,
    name: string,
    key: string,
    delta: number,
  ): void {
    let byLabel = map.get(name);
    if (!byLabel) {
      byLabel = new Map();
      map.set(name, byLabel);
    }
    byLabel.set(key, (byLabel.get(key) ?? 0) + delta);
  }

  function setMap(
    map: Map<string, Map<string, number>>,
    name: string,
    key: string,
    value: number,
  ): void {
    let byLabel = map.get(name);
    if (!byLabel) {
      byLabel = new Map();
      map.set(name, byLabel);
    }
    byLabel.set(key, value);
  }

  function escapeLabelValue(value: string): string {
    return value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n');
  }

  function formatLabels(key: string): string {
    if (key === '') return '';
    const pairs = key.split('|').map((kv) => {
      const eq = kv.indexOf('=');
      const k = kv.slice(0, eq);
      const v = kv.slice(eq + 1);
      return `${k}="${escapeLabelValue(v)}"`;
    });
    return `{${pairs.join(',')}}`;
  }

  return {
    inc(name, labels, value = 1): void {
      bump(counters, name, labelKey(labels), value);
    },
    setGauge(name, value, labels): void {
      setMap(gauges, name, labelKey(labels), value);
    },
    render(): string {
      const lines: string[] = [];
      for (const [name, byLabel] of counters) {
        const fullName = `${namespace}_${name}_total`;
        lines.push(`# TYPE ${fullName} counter`);
        for (const [key, value] of byLabel) {
          lines.push(`${fullName}${formatLabels(key)} ${String(value)}`);
        }
      }
      for (const [name, byLabel] of gauges) {
        const fullName = `${namespace}_${name}`;
        lines.push(`# TYPE ${fullName} gauge`);
        for (const [key, value] of byLabel) {
          lines.push(`${fullName}${formatLabels(key)} ${String(value)}`);
        }
      }
      return lines.length > 0 ? lines.join('\n') + '\n' : '';
    },
  };
}

/** Discards all metrics. Useful in tests. */
export function noopMetrics(): Metrics {
  return {
    inc(): void {},
    setGauge(): void {},
    render(): string {
      return '';
    },
  };
}
