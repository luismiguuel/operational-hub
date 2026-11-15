import { useQuery } from '@tanstack/react-query';
import { metricsSchema } from '@hub/shared';
import { api } from '../core/api';
import { ErrorMessage } from '../core/components';
export function ProjectMetrics({ projectId }: { projectId: string }) {
  const query = useQuery({
    queryKey: ['metrics', projectId],
    queryFn: () => api(`/projects/${projectId}/metrics`, metricsSchema),
    refetchInterval: 30000,
  });
  if (!query.data) return <ErrorMessage error={query.error} />;
  const metrics = query.data,
    velocity = metrics.velocity.length
      ? Math.round(metrics.velocity.reduce((sum, s) => sum + s.points, 0) / metrics.velocity.length)
      : null;
  return (
    <>
      <div className="metric-strip">
        <div>
          <strong>{metrics.total}</strong>
          <span>tarefas no projeto</span>
        </div>
        <div>
          <strong>{metrics.completed}</strong>
          <span>entregas concluídas</span>
        </div>
        <div>
          <strong>{metrics.completedPoints}</strong>
          <span>pontos concluídos de {metrics.totalPoints}</span>
        </div>
        <div>
          <strong>{velocity ?? '—'}</strong>
          <span>velocidade média · últimas {metrics.velocity.length} sprints encerradas</span>
        </div>
      </div>
      {metrics.velocity.length > 0 && (
        <div className="velocity">
          <h3>Entregas por ciclo</h3>
          {metrics.velocity.map((s) => (
            <div className="velocity-row" key={s.id}>
              <span>{s.name}</span>
              <meter
                min={0}
                max={Math.max(...metrics.velocity.map((v) => v.points), 1)}
                value={s.points}
              >
                {s.points}
              </meter>
              <span>{s.points} pts</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
