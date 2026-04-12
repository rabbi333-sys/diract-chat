import { cn } from '@/lib/utils';
import { getActiveConnection } from '@/lib/db-config';
import { getStoredConnection } from '@/lib/externalDb';
import type { SyncMode } from '@/hooks/useRealtimeUpdates';

interface LiveSyncBadgeProps {
  connected: boolean;
  mode: SyncMode;
}

export function LiveSyncBadge({ connected, mode }: LiveSyncBadgeProps) {
  const hasDb = !!(getActiveConnection() || getStoredConnection());
  if (!hasDb) return null;

  const isGreen  = mode === 'realtime' && connected;
  const isYellow = mode === 'polling'  && connected;
  const isRed    = !connected || mode === 'none';

  const dotColor  = isGreen ? 'bg-green-500' : isYellow ? 'bg-yellow-400' : 'bg-red-500';
  const textColor = isGreen ? 'text-green-600 dark:text-green-400' : isYellow ? 'text-yellow-600 dark:text-yellow-400' : 'text-red-500 dark:text-red-400';
  const label     = isGreen ? 'Live Sync' : isYellow ? 'Polling' : 'Disconnected';
  const pulse     = isGreen || isYellow;

  return (
    <div
      className="flex items-center gap-1 select-none"
      title={
        isGreen  ? 'Real-time sync active — new messages appear instantly' :
        isYellow ? 'Smart polling active — updates every ~17 s when tab is visible' :
                   'Sync disconnected — data will not update automatically'
      }
    >
      <span className={cn('w-2 h-2 rounded-full flex-shrink-0', dotColor, pulse && 'animate-pulse')} />
      <span className={cn('text-[10px] font-semibold tracking-wide hidden lg:block', textColor)}>
        {label}
      </span>
    </div>
  );
}
