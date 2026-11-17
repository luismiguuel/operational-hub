import { knowledgeChange, synthesizeKnowledge } from '../core/knowledge.js';
import { knowledgeQueue } from '../core/redis.js';
import { config } from '../core/config.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createKnowledgeDocumentSchema,
  queryKnowledgeSchema,
  knowledgeDocumentSchema,
  id,
} from '@hub/shared';
import { authenticate } from './auth.js';
import { db, transaction, HttpError, found } from '../core/db.js';
import { projectAccess } from '../core/access.js';
import {
  citationRow,
  documentColumns,
  indexKnowledge,
  externalEmbedding,
} from '../core/knowledge.js';
const accessSql = `(d.project_id IS NULL OR $1='ADMIN' OR EXISTS(SELECT 1 FROM allocations a WHERE a.project_id=d.project_id AND a.user_id=$2))`;
export async function knowledgeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  app.get('/knowledge/documents', async (request) => {
    const scope = z.object({ projectId: id.optional() }).parse(request.query);
    if (scope.projectId) await projectAccess(request.actor, scope.projectId);
    const result = await db.query(
      `SELECT ${documentColumns
        .split(',')
        .map((c) => 'd.' + c)
        .join(
          ',',
        )} FROM knowledge_documents d WHERE ${accessSql} AND ($3::uuid IS NULL OR d.project_id=$3) ORDER BY d.created_at DESC LIMIT 200`,
      [request.actor.role, request.actor.id, scope.projectId ?? null],
    );
    return z.array(knowledgeDocumentSchema).parse(result.rows);
  });
  app.post('/knowledge/documents', async (request, reply) => {
    const body = createKnowledgeDocumentSchema.parse(request.body);
    if (body.projectId) await projectAccess(request.actor, body.projectId);
    else if (request.actor.role === 'MEMBER')
      throw new HttpError(403, 'Somente liderança ou diretoria pode criar documentos globais.');
    const documentId = crypto.randomUUID();
    await transaction(async (client) => {
      await client.query(
        'INSERT INTO knowledge_documents(id,project_id,title,category,content,created_by) VALUES($1,$2,$3,$4,$5,$6)',
        [
          documentId,
          body.projectId ?? null,
          body.title,
          body.category,
          body.content,
          request.actor.id,
        ],
      );
      await knowledgeChange(
        client,
        request.actor.id,
        documentId,
        body.projectId ?? null,
        'created',
      );
    });
    if (config.NODE_ENV === 'production') await knowledgeQueue.add('index', { documentId });
    else await indexKnowledge(documentId);
    return reply
      .code(201)
      .send(
        knowledgeDocumentSchema.parse(
          (
            await db.query(`SELECT ${documentColumns} FROM knowledge_documents WHERE id=$1`, [
              documentId,
            ])
          ).rows[0],
        ),
      );
  });
  app.post('/knowledge/query', async (request) => {
    const body = queryKnowledgeSchema.parse(request.body);
    if (body.projectId) await projectAccess(request.actor, body.projectId);
    const rows = await db.query(
      `SELECT d.id AS "documentId",d.title AS "documentTitle",d.category,d.project_id AS "projectId",p.name AS "projectName",c.content AS snippet,GREATEST(0,1-(c.embedding <=> $4::vector)) AS score FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id LEFT JOIN projects p ON p.id=d.project_id WHERE d.status='INDEXED' AND ${accessSql} AND ($3::uuid IS NULL OR d.project_id=$3) ORDER BY c.embedding <=> $4::vector,d.id,c.chunk_index LIMIT $5`,
      [
        request.actor.role,
        request.actor.id,
        body.projectId ?? null,
        JSON.stringify(await externalEmbedding(body.question)),
        body.limit,
      ],
    );
    const citations = z
      .array(citationRow)
      .parse(rows.rows)
      .filter((row) => row.score > 0);
    return {
      ...(await synthesizeKnowledge(
        body.question,
        citations.map((c) => c.snippet),
      )),
      citations,
    };
  });
  for (const operation of ['reindex', 'delete'] as const) {
    const handler = async (request: import('fastify').FastifyRequest) => {
      const { documentId } = z.object({ documentId: id }).parse(request.params);
      const doc = knowledgeDocumentSchema.parse(
        found(
          (
            await db.query(`SELECT ${documentColumns} FROM knowledge_documents WHERE id=$1`, [
              documentId,
            ])
          ).rows[0],
        ),
      );
      if (doc.projectId) await projectAccess(request.actor, doc.projectId);
      if (request.actor.role !== 'ADMIN' && doc.createdBy !== request.actor.id) {
        if (!doc.projectId) throw new HttpError(403, 'Operação não permitida.');
        await projectAccess(request.actor, doc.projectId, true);
      }
      if (operation === 'delete')
        await transaction(async (client) => {
          await client.query('DELETE FROM knowledge_documents WHERE id=$1', [documentId]);
          await knowledgeChange(client, request.actor.id, documentId, doc.projectId, 'deleted');
        });
      else {
        await transaction(async (client) => {
          await client.query("UPDATE knowledge_documents SET status='PENDING' WHERE id=$1", [
            documentId,
          ]);
          await knowledgeChange(client, request.actor.id, documentId, doc.projectId, 'reindex');
        });
        if (config.NODE_ENV === 'production') await knowledgeQueue.add('index', { documentId });
        else await indexKnowledge(documentId);
      }
      return { ok: true };
    };
    if (operation === 'delete') app.delete('/knowledge/documents/:documentId', handler);
    else app.post('/knowledge/documents/:documentId/reindex', handler);
  }
}
