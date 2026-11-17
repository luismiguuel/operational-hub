import { knowledgeSchema } from './knowledge-schema.js';
import { db, transaction } from '../core/db.js';
import { schema } from './schema.js';
try {
  await transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(721344)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const existing = await client.query('SELECT version FROM schema_migrations WHERE version=1');
    if (existing.rowCount === 0) {
      await client.query(schema);
      await client.query('INSERT INTO schema_migrations(version) VALUES(1)');
    }
    await client.query('ALTER TABLE sprints ADD COLUMN IF NOT EXISTS closed_at timestamptz');
    const next = await client.query('SELECT version FROM schema_migrations WHERE version=2');
    if (next.rowCount === 0) {
      await client.query(`
        ALTER TABLE users DROP CONSTRAINT IF EXISTS users_area_fkey;
        ALTER TABLE users DROP CONSTRAINT IF EXISTS users_check;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at timestamptz;
        UPDATE users SET is_active=active, deactivated_at=CASE WHEN active THEN NULL ELSE COALESCE(deactivated_at, now()) END;
        CREATE TABLE IF NOT EXISTS org_areas (
          id uuid PRIMARY KEY, name text NOT NULL UNIQUE, slug text NOT NULL UNIQUE,
          description text NOT NULL DEFAULT '', is_active boolean NOT NULL DEFAULT true,
          created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS org_subareas (
          id uuid PRIMARY KEY, area_id uuid NOT NULL REFERENCES org_areas(id),
          name text NOT NULL, slug text NOT NULL UNIQUE, is_active boolean NOT NULL DEFAULT true,
          created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE(area_id, name)
        );
        CREATE TABLE IF NOT EXISTS org_roles (
          id uuid PRIMARY KEY, name text NOT NULL UNIQUE, slug text NOT NULL UNIQUE,
          is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        INSERT INTO org_areas(id,name,slug,description) VALUES
          ('10000000-0000-4000-8000-000000000001','Tech','tech','Tecnologia e dados'),
          ('10000000-0000-4000-8000-000000000002','Produto','produto','Produto e experiência'),
          ('10000000-0000-4000-8000-000000000003','Gente e Gestão','gente-e-gestao','Pessoas e operação'),
          ('10000000-0000-4000-8000-000000000004','Negócios','negocios','Marketing e comercial')
        ON CONFLICT(slug) DO NOTHING;
        INSERT INTO org_subareas(id,area_id,name,slug) VALUES
          ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Dev','tech-dev'),
          ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','Dados','tech-dados'),
          ('20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000002','Design/UX','produto-design-ux'),
          ('20000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000002','Product Management','produto-product-management'),
          ('20000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000004','Marketing','negocios-marketing'),
          ('20000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000004','Comercial','negocios-comercial')
        ON CONFLICT(slug) DO NOTHING;
        INSERT INTO org_roles(id,name,slug) VALUES
          ('30000000-0000-4000-8000-000000000001','Diretoria','diretoria'),
          ('30000000-0000-4000-8000-000000000002','Liderança de Projeto','lideranca-de-projeto'),
          ('30000000-0000-4000-8000-000000000003','Consultor','consultor'),
          ('30000000-0000-4000-8000-000000000004','Desenvolvedor','desenvolvedor'),
          ('30000000-0000-4000-8000-000000000005','Designer','designer'),
          ('30000000-0000-4000-8000-000000000006','Analista de Dados','analista-de-dados')
        ON CONFLICT(slug) DO NOTHING;
        INSERT INTO areas(name,subareas) VALUES
          ('Tech','["Dev","Dados"]'),('Produto','["Design/UX","Product Management"]'),
          ('Gente e Gestão','[]'),('Negócios','["Marketing","Comercial"]')
        ON CONFLICT(name) DO NOTHING;
        INSERT INTO schema_migrations(version) VALUES(2);
      `);
    }
    const backlog = await client.query('SELECT version FROM schema_migrations WHERE version=3');
    if (backlog.rowCount === 0) {
      await client.query(`
        ALTER TABLE tasks ADD COLUMN IF NOT EXISTS backlog_position integer NOT NULL DEFAULT 0;
        WITH ranked_backlog AS (
          SELECT id, row_number() OVER (PARTITION BY project_id ORDER BY created_at ASC, id ASC) - 1 AS position
          FROM tasks WHERE sprint_id IS NULL
        )
        UPDATE tasks AS task SET backlog_position=ranked_backlog.position
        FROM ranked_backlog WHERE task.id=ranked_backlog.id;
        CREATE INDEX IF NOT EXISTS tasks_project_sprint_backlog_position
          ON tasks(project_id,sprint_id,backlog_position);
        INSERT INTO schema_migrations(version) VALUES(3);
      `);
    }
    await client.query(knowledgeSchema);
    await client.query('INSERT INTO schema_migrations(version) VALUES(4) ON CONFLICT DO NOTHING');
  });
  console.info('Migrações aplicadas (versões 1 a 4).');
} finally {
  await db.end();
}
