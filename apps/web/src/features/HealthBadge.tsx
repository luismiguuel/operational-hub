import type { ProjectHealthReport } from '@hub/shared';
export function HealthBadge({ report }: { report: ProjectHealthReport }) {
  const label = { HEALTHY: 'Saudável', WARNING: 'Atenção', CRITICAL: 'Risco' }[report.status];
  return (
    <details className="health-details">
      <summary className={`health-badge health-${report.status.toLowerCase()}`}>
        {label} · {report.score}/100
      </summary>
      <div className="health-content">
        <dl>
          <div>
            <dt>Taxa de entrega</dt>
            <dd>{report.metrics.completionRate}%</dd>
          </div>
          <div>
            <dt>Tarefas vencidas</dt>
            <dd>{report.metrics.overdueTasksCount}</dd>
          </div>
          <div>
            <dt>Bloqueadas/estagnadas</dt>
            <dd>{report.metrics.blockedTasksCount}</dd>
          </div>
          <div>
            <dt>Carryover</dt>
            <dd>{report.metrics.carryoverRate}%</dd>
          </div>
        </dl>
        {report.signals.length > 0 && (
          <ul>
            {report.signals.map((signal, index) => (
              <li key={`${index}-${signal}`}>{signal}</li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
