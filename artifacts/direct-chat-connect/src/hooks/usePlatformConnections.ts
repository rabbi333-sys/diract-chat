import { useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

export interface PlatformConnection {
  id: string;
  platform: 'facebook' | 'whatsapp' | 'instagram';
  label: string | null;
  access_token: string;
  page_id: string | null;
  phone_number_id: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

const STORAGE_KEY = 'chat_monitor_platform_connections';

function loadConnections(): PlatformConnection[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as PlatformConnection[];
  } catch {
    return [];
  }
}

function saveConnections(conns: PlatformConnection[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(conns));
}

function genId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export const usePlatformConnections = () => {
  return useQuery({
    queryKey: ['platform-connections'],
    staleTime: Infinity,
    queryFn: (): PlatformConnection[] => loadConnections(),
  });
};

export const useAddPlatformConnection = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: Omit<PlatformConnection, 'id' | 'created_at' | 'updated_at'>) => {
      const conns = loadConnections();
      const now = new Date().toISOString();
      const newConn: PlatformConnection = { ...payload, id: genId(), created_at: now, updated_at: now };
      saveConnections([...conns, newConn]);
      return newConn;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['platform-connections'] }),
  });
};

export const useUpdatePlatformConnection = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...updates }: Partial<PlatformConnection> & { id: string }) => {
      const conns = loadConnections();
      const updated = conns.map((c) =>
        c.id === id ? { ...c, ...updates, updated_at: new Date().toISOString() } : c
      );
      saveConnections(updated);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['platform-connections'] }),
  });
};

export const useDeletePlatformConnection = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const conns = loadConnections().filter((c) => c.id !== id);
      saveConnections(conns);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['platform-connections'] }),
  });
};
