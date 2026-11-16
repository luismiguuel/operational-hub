import { EventEmitter } from 'node:events';
import type { DomainEvent } from '@hub/shared';
import { eventSchema } from '@hub/shared';
import { transaction } from './db.js';
import { redis } from './redis.js';
// Typed in-process bus; the transactional outbox bridges processes using Redis Pub/Sub.
export class DomainBus {
  private readonly emitter = new EventEmitter();
  on(type: DomainEvent['type'], handler: (event: DomainEvent) => void): () => void {
    this.emitter.on(type, handler);
    return () => {
      this.emitter.off(type, handler);
    };
  }
  publish(event: DomainEvent): void {
    this.emitter.emit(event.type, event);
    this.emitter.emit('project-event', event);
  }
  onEvent(handler: (event: DomainEvent) => void): () => void {
    this.emitter.on('project-event', handler);
    return () => {
      this.emitter.off('project-event', handler);
    };
  }
}
export const bus = new DomainBus();
export async function publishOutbox(): Promise<void> {
  await transaction(async (client) => {
    const rows = await client.query<{ id: string; payload: unknown }>(
      'SELECT id,payload FROM outbox WHERE published_at IS NULL ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 50',
    );
    for (const row of rows.rows) {
      const event = eventSchema.parse(row.payload);
      await redis.incr('dashboard:revision');
      await redis.publish(
        event.type === 'OrgManagementChanged' ? 'org:management' : `project:${event.projectId}`,
        JSON.stringify(event),
      );
      await client.query('UPDATE outbox SET published_at=now() WHERE id=$1', [row.id]);
    }
  });
}
