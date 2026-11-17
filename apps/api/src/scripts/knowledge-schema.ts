export const knowledgeSchema = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS knowledge_documents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
 title text NOT NULL, category text NOT NULL CHECK(category IN ('ADR','HANDOVER','SCOPE','RETROSPECTIVE','PROCESS')),
 content text NOT NULL, status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','INDEXED','FAILED')),
 error_message text, created_by uuid NOT NULL REFERENCES users(id), indexed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE knowledge_chunks ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS document_id uuid REFERENCES knowledge_documents(id) ON DELETE CASCADE;
ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS chunk_index integer NOT NULL DEFAULT 0;
ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS knowledge_document_project ON knowledge_documents(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_document_chunk ON knowledge_chunks(document_id,chunk_index);
`;
