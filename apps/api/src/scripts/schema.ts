// DDL lives in TypeScript: no JavaScript or external SQL scripts in the codebase.
export const schema = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE areas (name text PRIMARY KEY, subareas jsonb NOT NULL);
CREATE TABLE users (
 id uuid PRIMARY KEY, name text NOT NULL, email text UNIQUE NOT NULL, role text NOT NULL CHECK(role IN ('ADMIN','LEADER','MEMBER')),
 area text NOT NULL REFERENCES areas(name), subarea text, title text NOT NULL,
 weekly_hours integer NOT NULL CHECK(weekly_hours BETWEEN 1 AND 40), active boolean NOT NULL DEFAULT true,
 password_hash text, google_sub text UNIQUE,
 CHECK((area='Tech' AND (subarea IS NULL OR subarea IN ('Dev','Dados'))) OR
 (area='Produto' AND (subarea IS NULL OR subarea IN ('Design/UX','Product Management'))) OR
 (area='Gente e Gestão' AND subarea IS NULL) OR (area='Negócios' AND (subarea IS NULL OR subarea IN ('Marketing','Comercial'))))
);
CREATE TABLE projects (id uuid PRIMARY KEY, name text NOT NULL, description text NOT NULL, kind text NOT NULL CHECK(kind IN ('EXTERNAL','INTERNAL')),archived boolean NOT NULL DEFAULT false);
CREATE TABLE allocations (project_id uuid REFERENCES projects(id),user_id uuid REFERENCES users(id),role text NOT NULL CHECK(role IN ('LEADER','MEMBER')),weekly_hours integer NOT NULL CHECK(weekly_hours BETWEEN 1 AND 40), PRIMARY KEY(project_id,user_id));
CREATE INDEX allocations_user ON allocations(user_id);
CREATE TABLE sprints (id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id),name text NOT NULL,goal text NOT NULL,starts_on date NOT NULL,ends_on date NOT NULL,state text NOT NULL DEFAULT 'PLANNED' CHECK(state IN ('PLANNED','ACTIVE','CLOSED')),CHECK(ends_on>=starts_on),UNIQUE(project_id,id));
CREATE UNIQUE INDEX one_active_sprint ON sprints(project_id) WHERE state='ACTIVE';
CREATE TABLE tasks (
 id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id),sprint_id uuid,epic_id uuid,
 title text NOT NULL,description text NOT NULL DEFAULT '',acceptance text NOT NULL DEFAULT '',kind text NOT NULL DEFAULT 'TASK' CHECK(kind IN ('EPIC','TASK')),
 assignee_id uuid,created_by uuid NOT NULL REFERENCES users(id),status text NOT NULL DEFAULT 'TODO' CHECK(status IN ('TODO','IN_PROGRESS','REVIEW','DONE')),
 points integer NOT NULL CHECK(points IN (1,2,3,5,8)),priority text NOT NULL CHECK(priority IN ('HIGH','MEDIUM','LOW')),due_date date,
 tags jsonb NOT NULL DEFAULT '[]',checklist jsonb NOT NULL DEFAULT '[]',links jsonb NOT NULL DEFAULT '[]',version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(project_id,id),
 FOREIGN KEY(project_id,sprint_id) REFERENCES sprints(project_id,id),
 FOREIGN KEY(project_id,assignee_id) REFERENCES allocations(project_id,user_id),
 FOREIGN KEY(project_id,epic_id) REFERENCES tasks(project_id,id),CHECK(epic_id IS NULL OR epic_id<>id)
);
CREATE INDEX tasks_project_sprint ON tasks(project_id,sprint_id);
CREATE INDEX tasks_assignee ON tasks(assignee_id);
CREATE INDEX tasks_tags_gin ON tasks USING gin(tags);
CREATE INDEX tasks_checklist_gin ON tasks USING gin(checklist);
CREATE TABLE comments(id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES tasks(id),user_id uuid NOT NULL REFERENCES users(id),body text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE activity_log(id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id),actor_id uuid NOT NULL REFERENCES users(id),action text NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX activity_project ON activity_log(project_id,created_at);
CREATE TABLE audit_log(id uuid PRIMARY KEY,actor_id uuid REFERENCES users(id),action text NOT NULL,resource_id uuid,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX audit_payload_gin ON audit_log USING gin(payload);
CREATE FUNCTION prevent_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION prevent_audit_mutation();
CREATE TABLE refresh_tokens(hash text PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),family_id uuid NOT NULL,expires_at timestamptz NOT NULL,revoked boolean NOT NULL DEFAULT false);
CREATE INDEX refresh_family ON refresh_tokens(family_id);
CREATE TABLE outbox(id uuid PRIMARY KEY,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),published_at timestamptz);
CREATE INDEX outbox_pending ON outbox(created_at) WHERE published_at IS NULL;
CREATE TABLE knowledge_chunks(id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id),source_task_id uuid REFERENCES tasks(id),content text NOT NULL,metadata jsonb NOT NULL DEFAULT '{}',embedding vector(1536));
CREATE INDEX knowledge_metadata_gin ON knowledge_chunks USING gin(metadata);
CREATE INDEX knowledge_project ON knowledge_chunks(project_id);
CREATE INDEX knowledge_embedding_hnsw ON knowledge_chunks USING hnsw(embedding vector_cosine_ops);
`;
