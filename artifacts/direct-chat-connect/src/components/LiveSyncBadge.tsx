import { cn } from '@/lib/utils';
import { getActiveConnection } from '@/lib/db-config';
import { getStoredConnection } from '@/lib/externalDb';
import type { SyncMode } from '@/hooks/useRealtimeUpdates';

interface LiveSyncBadgeProps {
  connected: boolean;
  mode: SyncMode;
  paused?: boolean;
}

export function LiveSyncBadge({ connected, mode, paused = false }: LiveSyncBadgeProps) {
  const hasDb = !!(getActiveConnection() || getStoredConnection());
  if (!hasDb) return null;

  const isLive    = mode === 'realtime' && connected;
  const isPolling = mode === 'polling'  && connected && !paused;
  const isPaused  = mode === 'polling'  && paused;
  const isOff     = !connected && !isPaused;

  const dotColor  = isLive    ? 'bg-green-500'
                  : isPolling ? 'bg-yellow-400'
                  : isPaused  ? 'bg-amber-400'
                  : 'bg-red-500';

  const textColor = isLive    ? 'text-green-600 dark:text-green-400'
                  : isPolling ? 'text-yellow-600 dark:text-yellow-400'
                  : isPaused  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-red-500 dark:text-red-400';

  const label     = isLive    ? 'Live'
                  : isPolling ? 'Polling'
                  : isPaused  ? 'Paused'
                  : 'Disconnected';

  const pulse     = isLive || isPolling;

  const tooltip   = isLive    ? 'Real-time sync active — new messages appear instantly'
                  : isPolling ? 'Smart polling every 15 s while this tab is active'
                  : isPaused  ? 'Polling paused — switch back to this tab to resume'
                  : 'Sync disconnected — data will not update automatically';

  return (
    <div className="flex items-center gap-1 select-none" title={tooltip}>
      <span className={cn('w-2 h-2 rounded-full flex-shrink-0', dotColor, pulse && 'animate-pulse')} />
      <span className={cn('text-[10px] font-semibold tracking-wide hidden lg:block', textColor)}>
        {label}
      </span>
    </div>
  );
}
