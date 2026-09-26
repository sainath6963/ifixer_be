import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { performance } from 'node:perf_hooks';

type MetricLabels = Record<string, string>;

interface MetricSeries {
  labels: MetricLabels;
  value: number;
}

interface MetricFamily {
  help: string;
  series: Map<string, MetricSeries>;
}

interface HistogramSeries {
  labels: MetricLabels;
  buckets: number[];
  count: number;
  sum: number;
}

interface HistogramFamily {
  help: string;
  series: Map<string, HistogramSeries>;
}

const HISTOGRAM_BUCKETS_SECONDS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, MetricFamily>();
  private readonly gauges = new Map<string, MetricFamily>();
  private readonly histograms = new Map<string, HistogramFamily>();

  constructor(config: ConfigService) {
    this.replaceGauge('rich_culture_build_info', 'Application release metadata', [
      {
        labels: {
          release: config.getOrThrow<string>('APP_RELEASE'),
          environment: config.getOrThrow<string>('NODE_ENV'),
        },
        value: 1,
      },
    ]);
  }

  incrementCounter(name: string, help: string, labels: MetricLabels = {}, amount = 1): void {
    if (!Number.isFinite(amount) || amount < 0) throw new Error('Counter amount is invalid');
    const family = this.family(this.counters, name, help);
    const key = this.labelKey(labels);
    const existing = family.series.get(key);
    family.series.set(key, { labels: { ...labels }, value: (existing?.value ?? 0) + amount });
  }

  replaceGauge(name: string, help: string, series: MetricSeries[]): void {
    this.assertMetricName(name);
    this.assertMetricTypeAvailable(name, 'gauge');
    const next = new Map<string, MetricSeries>();
    for (const sample of series) {
      if (!Number.isFinite(sample.value)) continue;
      next.set(this.labelKey(sample.labels), {
        labels: { ...sample.labels },
        value: sample.value,
      });
    }
    this.gauges.set(name, { help, series: next });
  }

  observeHistogram(name: string, help: string, labels: MetricLabels, value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    this.assertMetricName(name);
    this.assertMetricTypeAvailable(name, 'histogram');
    const family: HistogramFamily = this.histograms.get(name) ?? {
      help,
      series: new Map<string, HistogramSeries>(),
    };
    if (family.help !== help) throw new Error(`Metric ${name} help text changed`);
    const key = this.labelKey(labels);
    const existing = family.series.get(key) ?? {
      labels: { ...labels },
      buckets: HISTOGRAM_BUCKETS_SECONDS.map(() => 0),
      count: 0,
      sum: 0,
    };
    HISTOGRAM_BUCKETS_SECONDS.forEach((bucket, index) => {
      if (value <= bucket) existing.buckets[index] += 1;
    });
    existing.count += 1;
    existing.sum += value;
    family.series.set(key, existing);
    this.histograms.set(name, family);
  }

  async trackJob<T>(queue: string, job: string, operation: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    let outcome = 'success';
    try {
      return await operation();
    } catch (error: unknown) {
      outcome = 'failed';
      throw error;
    } finally {
      const labels = { queue, job, outcome };
      this.incrementCounter(
        'rich_culture_queue_job_runs_total',
        'Completed background job runs by outcome',
        labels,
      );
      this.observeHistogram(
        'rich_culture_queue_job_duration_seconds',
        'Background job execution duration in seconds',
        labels,
        (performance.now() - startedAt) / 1000,
      );
    }
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, family] of [...this.counters.entries()].sort()) {
      this.renderFamily(lines, name, 'counter', family);
    }
    for (const [name, family] of [...this.gauges.entries()].sort()) {
      this.renderFamily(lines, name, 'gauge', family);
    }
    for (const [name, family] of [...this.histograms.entries()].sort()) {
      lines.push(`# HELP ${name} ${this.escapeHelp(family.help)}`);
      lines.push(`# TYPE ${name} histogram`);
      for (const sample of [...family.series.values()].sort((left, right) =>
        this.labelKey(left.labels).localeCompare(this.labelKey(right.labels)),
      )) {
        HISTOGRAM_BUCKETS_SECONDS.forEach((bucket, index) => {
          lines.push(
            `${name}_bucket${this.formatLabels({ ...sample.labels, le: String(bucket) })} ${sample.buckets[index]}`,
          );
        });
        lines.push(
          `${name}_bucket${this.formatLabels({ ...sample.labels, le: '+Inf' })} ${sample.count}`,
        );
        lines.push(`${name}_sum${this.formatLabels(sample.labels)} ${sample.sum}`);
        lines.push(`${name}_count${this.formatLabels(sample.labels)} ${sample.count}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }

  private family(store: Map<string, MetricFamily>, name: string, help: string): MetricFamily {
    this.assertMetricName(name);
    this.assertMetricTypeAvailable(name, store === this.counters ? 'counter' : 'gauge');
    const family = store.get(name) ?? { help, series: new Map() };
    if (family.help !== help) throw new Error(`Metric ${name} help text changed`);
    store.set(name, family);
    return family;
  }

  private renderFamily(
    lines: string[],
    name: string,
    type: 'counter' | 'gauge',
    family: MetricFamily,
  ): void {
    lines.push(`# HELP ${name} ${this.escapeHelp(family.help)}`);
    lines.push(`# TYPE ${name} ${type}`);
    for (const sample of [...family.series.values()].sort((left, right) =>
      this.labelKey(left.labels).localeCompare(this.labelKey(right.labels)),
    )) {
      lines.push(`${name}${this.formatLabels(sample.labels)} ${sample.value}`);
    }
  }

  private assertMetricTypeAvailable(name: string, type: 'counter' | 'gauge' | 'histogram'): void {
    if (type !== 'counter' && this.counters.has(name))
      throw new Error(`Metric ${name} type changed`);
    if (type !== 'gauge' && this.gauges.has(name)) throw new Error(`Metric ${name} type changed`);
    if (type !== 'histogram' && this.histograms.has(name)) {
      throw new Error(`Metric ${name} type changed`);
    }
  }

  private assertMetricName(name: string): void {
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) throw new Error('Metric name is invalid');
  }

  private labelKey(labels: MetricLabels): string {
    return Object.entries(labels)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join('\u0000');
  }

  private formatLabels(labels: MetricLabels): string {
    const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));
    if (!entries.length) return '';
    return `{${entries.map(([key, value]) => `${key}="${this.escapeLabel(value)}"`).join(',')}}`;
  }

  private escapeLabel(value: string): string {
    return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');
  }

  private escapeHelp(value: string): string {
    return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n');
  }
}
