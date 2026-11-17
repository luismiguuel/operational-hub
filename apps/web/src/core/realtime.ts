import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { wsServerSchema } from '@hub/shared';
import { refresh, useSession } from './api';
export function useProjectRoom(projectId: string) {
  const client = useQueryClient(),
    token = useSession((s) => s.accessToken);
  useEffect(() => {
    if (!token) return;
    let socket: WebSocket | undefined,
      timer: ReturnType<typeof setTimeout> | undefined,
      stopped = false,
      attempts = 0;
    const connect = () => {
      socket = new WebSocket(
        `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/ws/projects/${projectId}`,
      );
      socket.onopen = () => {
        socket?.send(
          JSON.stringify({ type: 'authenticate', accessToken: useSession.getState().accessToken }),
        );
      };
      socket.onmessage = (event) => {
        try {
          const message = wsServerSchema.parse(JSON.parse(String(event.data)));
          if (message.type === 'ready') {
            attempts = 0;
          }
          if (
            message.type === 'ready' ||
            message.type === 'TaskStatusChanged' ||
            message.type === 'TaskCarriedOver' ||
            message.type === 'SprintClosed' ||
            message.type === 'BacklogReordered' ||
            message.type === 'TaskPulledToSprint' ||
            message.type === 'BacklogPulledToSprint'
          ) {
            void client.invalidateQueries({ queryKey: ['tasks', projectId] });
            void client.invalidateQueries({ queryKey: ['mine'] });
            void client.invalidateQueries({ queryKey: ['heat'] });
            void client.invalidateQueries({ queryKey: ['sprints', projectId] });
            void client.invalidateQueries({ queryKey: ['metrics', projectId] });
            void client.invalidateQueries({ queryKey: ['activity', projectId] });
          }
        } catch {
          /* Invalid payloads never enter application state. */
        }
      };
      socket.onclose = (event) => {
        if (stopped) return;
        timer = setTimeout(
          () => {
            void (async () => {
              if (event.code === 1008) {
                if (!(await refresh())) return;
              }
              if (!stopped) connect();
            })().catch(() => undefined);
          },
          Math.min(30000, 1000 * 2 ** attempts++),
        );
      };
    };
    connect();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      socket?.close();
    };
  }, [projectId, token, client]);
}
