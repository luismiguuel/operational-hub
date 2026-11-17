import { localEmbedding } from '../core/knowledge.js';
import argon2 from 'argon2';
import { z } from 'zod';
import { areas } from '@hub/shared';
import { db, transaction } from '../core/db.js';
const credentials = z
  .object({
    SEED_ADMIN_EMAIL: z.string().email(),
    SEED_ADMIN_PASSWORD: z.string().min(12).max(256),
  })
  .safeParse(process.env);
if (!credentials.success) {
  console.error(
    'Credenciais de seed inválidas. Execute pnpm run setup ou preencha SEED_ADMIN_EMAIL e SEED_ADMIN_PASSWORD (12+ caracteres) no .env.',
  );
  process.exit(1);
}
const email = credentials.data.SEED_ADMIN_EMAIL.toLowerCase();
const password = credentials.data.SEED_ADMIN_PASSWORD;

try {
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  await transaction(async (client) => {
    const taxonomy = [
      {
        id: '10000000-0000-4000-8000-000000000001',
        name: 'Tech',
        slug: 'tech',
        description: 'Tecnologia e dados',
        subareas: ['Dev', 'Dados'],
      },
      {
        id: '10000000-0000-4000-8000-000000000002',
        name: 'Produto',
        slug: 'produto',
        description: 'Produto e experiência',
        subareas: ['Design/UX', 'Product Management'],
      },
      {
        id: '10000000-0000-4000-8000-000000000003',
        name: 'Gente e Gestão',
        slug: 'gente-e-gestao',
        description: 'Pessoas e operação',
        subareas: [],
      },
      {
        id: '10000000-0000-4000-8000-000000000004',
        name: 'Negócios',
        slug: 'negocios',
        description: 'Marketing e comercial',
        subareas: ['Marketing', 'Comercial'],
      },
    ];
    for (const area of taxonomy) {
      await client.query(
        'INSERT INTO org_areas(id,name,slug,description) VALUES($1,$2,$3,$4) ON CONFLICT(slug) DO NOTHING',
        [area.id, area.name, area.slug, area.description],
      );
      const areaRow = await client.query<{ id: string }>('SELECT id FROM org_areas WHERE slug=$1', [
        area.slug,
      ]);
      for (const name of area.subareas) {
        const slug = `${area.slug}-${name
          .normalize('NFD')
          .replace(/[\\u0300-\\u036f]/g, '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')}`;
        await client.query(
          'INSERT INTO org_subareas(id,area_id,name,slug) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [crypto.randomUUID(), areaRow.rows[0]?.id, name, slug],
        );
      }
    }
    for (const [index, name] of [
      'Diretoria',
      'Liderança de Projeto',
      'Consultor',
      'Desenvolvedor',
      'Designer',
      'Analista de Dados',
    ].entries()) {
      const slug = [
        'diretoria',
        'lideranca-de-projeto',
        'consultor',
        'desenvolvedor',
        'designer',
        'analista-de-dados',
      ][index];
      await client.query(
        'INSERT INTO org_roles(id,name,slug) VALUES($1,$2,$3) ON CONFLICT(slug) DO NOTHING',
        [crypto.randomUUID(), name, slug],
      );
    }
    for (const [area, subareas] of Object.entries(areas))
      await client.query('INSERT INTO areas(name,subareas) VALUES($1,$2) ON CONFLICT DO NOTHING', [
        area,
        JSON.stringify(subareas),
      ]);
    const adminId = crypto.randomUUID();
    const inserted = await client.query(
      "INSERT INTO users(id,name,email,role,area,subarea,title,weekly_hours,password_hash) VALUES($1,'Administrador',$2,'ADMIN','Tech','Dev','Diretoria',20,$3) ON CONFLICT(email) DO NOTHING RETURNING id",
      [adminId, email, hash],
    );
    const owner = (
      await client.query<{ id: string }>('SELECT id FROM users WHERE email=$1', [email])
    ).rows[0];
    if (owner)
      for (const [documentId, title, category, content] of [
        [
          '40000000-0000-4000-8000-000000000001',
          'Arquitetura do CITi Hub',
          'ADR',
          'O CITi Hub usa TypeScript estrito em monorepo pnpm. A API Fastify compartilha contratos Zod com a SPA React. PostgreSQL persiste tarefas e auditoria; Redis distribui eventos e filas.',
        ],
        [
          '40000000-0000-4000-8000-000000000002',
          'Checklist de handover',
          'HANDOVER',
          'Ao transferir um projeto, registre decisões técnicas, pendências, critérios de aceite e links dos artefatos. Confirme os responsáveis e documente como iniciar o ambiente local. Nunca registre senhas ou tokens no handover.',
        ],
      ]) {
        await client.query(
          "INSERT INTO knowledge_documents(id,title,category,content,created_by,status,indexed_at) VALUES($1,$2,$3,$4,$5,'INDEXED',now()) ON CONFLICT(id) DO NOTHING",
          [documentId, title, category, content, owner.id],
        );
        await client.query(
          'INSERT INTO knowledge_chunks(id,document_id,chunk_index,content,embedding) VALUES($1,$2,0,$3,$4::vector) ON CONFLICT(document_id,chunk_index) DO NOTHING',
          [crypto.randomUUID(), documentId, content, JSON.stringify(localEmbedding(content ?? ''))],
        );
      }
    await client.query(
      "UPDATE knowledge_documents SET project_id=NULL WHERE project_id IN (SELECT id FROM projects WHERE lower(name)='memória institucional')",
    );
    await client.query(
      "DELETE FROM allocations WHERE project_id IN (SELECT id FROM projects WHERE lower(name)='memória institucional')",
    );
    await client.query("DELETE FROM projects WHERE lower(name)='memória institucional'");
    if (process.env['SEED_DEMO'] !== 'true' || !inserted.rowCount) return;
    // Illustrative dataset; opt-in and only inserted with a newly created administrator.
    const projectId = crypto.randomUUID(),
      sprintId = crypto.randomUUID();
    await client.query(
      "INSERT INTO projects(id,name,description,kind) VALUES($1,'Portal do cliente','Dados ilustrativos • Experiência digital para acompanhamento de entregas.','EXTERNAL')",
      [projectId],
    );
    const members = [
      {
        name: 'Ana Costa',
        email: 'ana@example.org',
        role: 'LEADER',
        area: 'Produto',
        subarea: 'Product Management',
        title: 'Product Owner',
        hours: 20,
      },
      {
        name: 'Lucas Almeida',
        email: 'lucas@example.org',
        role: 'MEMBER',
        area: 'Tech',
        subarea: 'Dev',
        title: 'Desenvolvedor',
        hours: 16,
      },
      {
        name: 'Marina Santos',
        email: 'marina@example.org',
        role: 'MEMBER',
        area: 'Produto',
        subarea: 'Design/UX',
        title: 'Designer',
        hours: 12,
      },
    ];
    const memberIds: string[] = [];
    for (const member of members) {
      const memberId = crypto.randomUUID();
      memberIds.push(memberId);
      await client.query(
        'INSERT INTO users(id,name,email,role,area,subarea,title,weekly_hours) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          memberId,
          member.name,
          member.email,
          member.role,
          member.area,
          member.subarea,
          member.title,
          member.hours,
        ],
      );
      await client.query(
        'INSERT INTO allocations(project_id,user_id,role,weekly_hours) VALUES($1,$2,$3,$4)',
        [projectId, memberId, member.role === 'LEADER' ? 'LEADER' : 'MEMBER', member.hours - 2],
      );
    }
    await client.query(
      "INSERT INTO allocations(project_id,user_id,role,weekly_hours) VALUES($1,$2,'LEADER',8)",
      [projectId, adminId],
    );
    await client.query(
      "INSERT INTO sprints(id,project_id,name,goal,starts_on,ends_on,state) VALUES($1,$2,'Sprint 01','Validar a primeira jornada do cliente.',current_date,current_date+14,'ACTIVE')",
      [sprintId, projectId],
    );
    const titles = [
      'Mapear a jornada do cliente',
      'Estruturar contratos da API',
      'Criar componentes de navegação',
      'Implementar autenticação',
      'Revisar acessibilidade dos formulários',
      'Validar protótipo com stakeholders',
      'Documentar critérios de aceite',
      'Preparar handoff de design',
    ];
    const statuses = [
      'TODO',
      'TODO',
      'IN_PROGRESS',
      'IN_PROGRESS',
      'REVIEW',
      'DONE',
      'TODO',
      'TODO',
    ];
    for (const [index, title] of titles.entries())
      await client.query(
        'INSERT INTO tasks(id,project_id,sprint_id,title,description,acceptance,assignee_id,created_by,status,points,priority,due_date,tags) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,current_date+$12::int,$13)',
        [
          crypto.randomUUID(),
          projectId,
          index < 6 ? sprintId : null,
          title,
          'Contexto ilustrativo para explorar o workspace.',
          '- [ ] Revisão da liderança\n- [ ] Documentação atualizada',
          index % 3 === 0 ? adminId : memberIds[index % 3],
          adminId,
          statuses[index],
          index % 2 === 0 ? 3 : 5,
          index % 3 === 0 ? 'HIGH' : 'MEDIUM',
          index + 1,
          JSON.stringify([index % 2 === 0 ? 'Design/UX' : 'Dev']),
        ],
      );
    await client.query(
      "INSERT INTO audit_log(id,actor_id,action,resource_id,payload) VALUES($1,$2,'seed.demo',$3,'{\"illustrative\":true}')",
      [crypto.randomUUID(), adminId, projectId],
    );
  });
  console.info('Seed concluído. Contas existentes foram preservadas.');
} finally {
  await db.end();
}
