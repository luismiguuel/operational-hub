import { z } from 'zod';
export const id = z.string().uuid();
export const roleSchema = z.enum(['ADMIN', 'LEADER', 'MEMBER']);
export type Role = z.infer<typeof roleSchema>;
export const areas = {
  Tech: ['Dev', 'Dados'],
  Produto: ['Design/UX', 'Product Management'],
  'Gente e Gestão': [],
  Negócios: ['Marketing', 'Comercial'],
} as const;
export const areaSchema = z.enum(['Tech', 'Produto', 'Gente e Gestão', 'Negócios']);
export const specialtySchema = z.string().max(60);
export const profileInput = z
  .object({
    name: z.string().trim().min(2).max(120),
    email: z.string().email(),
    role: roleSchema,
    area: areaSchema,
    subarea: z.string().max(60).nullable(),
    title: z.string().max(120),
    weeklyHours: z.number().int().min(1).max(40),
  })
  .strict()
  .superRefine((value, ctx) => {
    const options: readonly string[] = areas[value.area];
    if (value.subarea !== null && !options.includes(value.subarea))
      ctx.addIssue({
        code: 'custom',
        path: ['subarea'],
        message: 'Subárea incompatível com a área.',
      });
  });
export const userSchema = profileInput.innerType().extend({ id, active: z.boolean() });
export type User = z.infer<typeof userSchema>;
export const projectInput = z
  .object({
    name: z.string().trim().min(3).max(120),
    description: z.string().max(5000).default(''),
    kind: z.enum(['EXTERNAL', 'INTERNAL']),
  })
  .strict();
export const projectSchema = projectInput.extend({
  id,
  archived: z.boolean(),
  myRole: z.enum(['LEADER', 'MEMBER']).nullable(),
});
export type Project = z.infer<typeof projectSchema>;
export const allocationInput = z
  .object({
    userId: id,
    role: z.enum(['LEADER', 'MEMBER']),
    weeklyHours: z.number().int().min(1).max(40),
  })
  .strict();
export const statusSchema = z.enum(['TODO', 'IN_PROGRESS', 'REVIEW', 'DONE']);
export type TaskStatus = z.infer<typeof statusSchema>;
export const statusLabels: Record<TaskStatus, string> = {
  TODO: 'A Fazer',
  IN_PROGRESS: 'Em Andamento',
  REVIEW: 'Em Revisão / QA',
  DONE: 'Concluído',
};
export const pointsSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(5),
  z.literal(8),
]);
export const checklistItem = z.object({ id, title: z.string().min(1).max(250), done: z.boolean() });
export const taskInput = z
  .object({
    title: z.string().trim().min(3).max(180),
    description: z.string().max(20000).default(''),
    acceptance: z.string().max(10000).default(''),
    kind: z.enum(['EPIC', 'TASK']).default('TASK'),
    epicId: id.nullable().default(null),
    assigneeId: id.nullable().default(null),
    sprintId: id.nullable().default(null),
    points: pointsSchema.default(1),
    priority: z.enum(['HIGH', 'MEDIUM', 'LOW']).default('MEDIUM'),
    dueDate: z.string().date().nullable().default(null),
    tags: z.array(specialtySchema).max(10).default([]),
    checklist: z.array(checklistItem).max(50).default([]),
    links: z
      .array(
        z
          .string()
          .url()
          .refine((url) => /^https:\/\//i.test(url), 'Use HTTPS.'),
      )
      .max(10)
      .default([]),
  })
  .strict();
export const taskSchema = taskInput.extend({
  id,
  projectId: id,
  status: statusSchema,
  version: z.number().int(),
  createdBy: id,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof taskSchema>;
export const taskPatch = taskInput
  .partial()
  .extend({ status: statusSchema.optional(), version: z.number().int().positive() })
  .strict();
export const sprintInput = z
  .object({
    name: z.string().trim().min(3).max(120),
    goal: z.string().min(3).max(2000),
    startsOn: z.string().date(),
    endsOn: z.string().date(),
  })
  .strict()
  .refine((s) => s.startsOn <= s.endsOn, 'Fim deve ser posterior ao início.');
export const sprintSchema = sprintInput
  .innerType()
  .extend({ id, projectId: id, state: z.enum(['PLANNED', 'ACTIVE', 'CLOSED']) });
export type Sprint = z.infer<typeof sprintSchema>;
export const closeSprintSchema = z
  .object({
    unfinishedAction: z.enum(['BACKLOG', 'NEXT_SPRINT']).default('BACKLOG'),
    targetSprintId: id.optional(),
  })
  .strict()
  .refine((input) => input.unfinishedAction !== 'NEXT_SPRINT' || input.targetSprintId, {
    message: 'Informe a sprint planejada de destino.',
    path: ['targetSprintId'],
  });
export type CloseSprintInput = z.infer<typeof closeSprintSchema>;
export const commentSchema = z.object({
  id,
  taskId: id,
  userId: id,
  author: z.string(),
  body: z.string(),
  createdAt: z.string(),
});
export const commentInput = z.object({ body: z.string().trim().min(1).max(5000) }).strict();
const taskStatusChangedSchema = z.object({
  id,
  type: z.literal('TaskStatusChanged'),
  projectId: id,
  taskId: id,
  actorId: id,
  from: statusSchema,
  to: statusSchema,
  occurredAt: z.string().datetime(),
});
const sprintEventBase = z.object({
  id,
  projectId: id,
  sprintId: id,
  actorId: id,
  occurredAt: z.string().datetime(),
});
export const eventSchema = z.discriminatedUnion('type', [
  taskStatusChangedSchema,
  sprintEventBase.extend({
    type: z.literal('TaskCarriedOver'),
    taskId: id,
    targetSprintId: id.nullable(),
  }),
  sprintEventBase.extend({
    type: z.literal('SprintClosed'),
    unfinishedAction: z.enum(['BACKLOG', 'NEXT_SPRINT']),
    targetSprintId: id.nullable(),
    doneCount: z.number().int().nonnegative(),
    donePoints: z.number().int().nonnegative(),
    carryoverCount: z.number().int().nonnegative(),
    carryoverPoints: z.number().int().nonnegative(),
  }),
]);
export type DomainEvent = z.infer<typeof eventSchema>;
export const wsClientSchema = z
  .object({ type: z.literal('authenticate'), accessToken: z.string().min(1) })
  .strict();
export const wsServerSchema = z.discriminatedUnion('type', [
  ...eventSchema.options,
  z.object({ type: z.literal('ready'), projectId: id }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export const authResponse = z.object({ accessToken: z.string(), user: userSchema });
export const loginInput = z
  .object({ email: z.string().email(), password: z.string().min(1).max(256) })
  .strict();
export const heatSchema = z.object({
  userId: id,
  name: z.string(),
  area: areaSchema,
  capacity: z.number(),
  allocated: z.number(),
  activeTasks: z.number(),
  points: z.number(),
});
export type HeatRow = z.infer<typeof heatSchema>;
export const aiJobSchema = z.object({
  id: z.string(),
  state: z.enum([
    'waiting',
    'active',
    'completed',
    'failed',
    'delayed',
    'unknown',
    'waiting-children',
    'prioritized',
  ]),
  result: z.string().nullable(),
});

export const metricsSchema = z.object({
  total: z.number(),
  completed: z.number(),
  completedPoints: z.number(),
  totalPoints: z.number(),
  velocity: z.array(z.object({ id, name: z.string(), points: z.number() })),
});
export const activitySchema = z.object({
  action: z.string(),
  payload: eventSchema,
  createdAt: z.string(),
});
export const auditSchema = z.object({
  id,
  actorId: id.nullable(),
  action: z.string(),
  resourceId: id.nullable(),
  payload: z.unknown(),
  createdAt: z.string(),
});
