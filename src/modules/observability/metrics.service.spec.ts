import { ConfigService } from '@nestjs/config';

import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  function service(): MetricsService {
    return new MetricsService(new ConfigService({ APP_RELEASE: 'phase23-test', NODE_ENV: 'test' }));
  }

  it('renders escaped counters, gauges, and cumulative histograms', () => {
    const metrics = service();
    metrics.incrementCounter('ifixer_test_total', 'Test counter', {
      outcome: 'quoted"value',
    });
    metrics.replaceGauge('ifixer_test_gauge', 'Test gauge', [
      { labels: { state: 'ready' }, value: 7 },
    ]);
    metrics.observeHistogram(
      'ifixer_test_duration_seconds',
      'Test duration',
      { outcome: 'success' },
      0.05,
    );

    const output = metrics.render();
    expect(output).toContain('ifixer_build_info{environment="test",release="phase23-test"} 1');
    expect(output).toContain('outcome="quoted\\"value"} 1');
    expect(output).toContain('ifixer_test_gauge{state="ready"} 7');
    expect(output).toContain('ifixer_test_duration_seconds_bucket{le="0.05",outcome="success"} 1');
    expect(output).toContain('ifixer_test_duration_seconds_bucket{le="+Inf",outcome="success"} 1');
  });

  it('records failed job runs and rethrows the original failure', async () => {
    const metrics = service();

    await expect(
      metrics.trackJob('payment-maintenance', 'reconcile-payments', () =>
        Promise.reject(new Error('simulated job failure')),
      ),
    ).rejects.toThrow('simulated job failure');
    expect(metrics.render()).toContain(
      'ifixer_queue_job_runs_total{job="reconcile-payments",outcome="failed",queue="payment-maintenance"} 1',
    );
  });
});
