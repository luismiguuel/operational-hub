import { createHash } from 'node:crypto';
import { z } from 'zod';
import { db, transaction } from './db.js';
export function chunkKnowledge(content: string): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < content.length; offset += 1000)
    chunks.push(content.slice(offset, offset + 1200));
  return chunks;
}
export function localEmbedding(content: string): number[] {
  const vector = Array<number>(1536).fill(0);
  for (const token of content
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .match(/[\p{L}\p{N}]+/gu) ?? []) {
    const hash = createHash('sha256').update(token).digest();
    const index = hash.readUInt32BE(0) % 1536;
    vector[index] = (vector[index] ?? 0) + 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => v / norm);
}
export async function indexKnowledge(documentId: string): Promise<void> {
  try {
    await transaction(async (client) => {
      const result = await client.query<{ content: string; project_id: string | null }>(
        'SELECT content,project_id FROM knowledge_documents WHERE id=$1 FOR UPDATE',
        [documentId],
      );
      const doc = result.rows[0];
      if (!doc) return;
      await client.query('DELETE FROM knowledge_chunks WHERE document_id=$1', [documentId]);
      for (const [index, content] of chunkKnowledge(doc.content).entries())
        await client.query(
          'INSERT INTO knowledge_chunks(id,document_id,project_id,chunk_index,content,embedding) VALUES($1,$2,$3,$4,$5,$6::vector)',
          [
            crypto.randomUUID(),
            documentId,
            doc.project_id,
            index,
            content,
            JSON.stringify(localEmbedding(content)),
          ],
        );
      await client.query(
        "UPDATE knowledge_documents SET status='INDEXED',indexed_at=now(),updated_at=now(),error_message=NULL WHERE id=$1",
        [documentId],
      );
    });
  } catch (error) {
    await db.query(
      "UPDATE knowledge_documents SET status='FAILED',error_message=$2,updated_at=now() WHERE id=$1",
      [documentId, 'Não foi possível indexar o documento.'],
    );
    throw error;
  }
}
export const documentColumns = `id,project_id AS "projectId",title,category,content,status,error_message AS "errorMessage",created_by AS "createdBy",indexed_at::text AS "indexedAt",created_at::text AS "createdAt",updated_at::text AS "updatedAt"`;
export const citationRow = z.object({
  documentId: z.string().uuid(),
  documentTitle: z.string(),
  category: z.enum(['ADR', 'HANDOVER', 'SCOPE', 'RETROSPECTIVE', 'PROCESS']),
  projectId: z.string().uuid().nullable(),
  projectName: z.string().nullable(),
  snippet: z.string(),
  score: z.number(),
});
