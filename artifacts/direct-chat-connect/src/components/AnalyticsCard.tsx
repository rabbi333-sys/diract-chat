import { useAnalytics } from '@/hooks/useChatHistory';
import { MessageSquare, Users, Bot, User } from 'lucide-react';
import { cn } from '@/lib/utils';

export const AnalyticsCard = () => {
  const { data: analytics, isLoading } = useAnalytics();

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="rounded-xl border border-border p-4 h-24 animate-pulse bg-muted" />
        ))}
      </div>
    );
  }

  const stats = [
    { label: 'Total Sessions',    value: analytics?.total_sessions  || 0, icon: Users,          color: 'text-stat-blue',   bg: 'bg-stat-blue/10' },
    { label: 'Total Messages',    value: analytics?.total_messages  || 0, icon: MessageSquare,  color: 'text-stat-green',  bg: 'bg-stat-green/10' },
    { label: 'Customer Messages', value: analytics?.human_messages  || 0, icon: User,           color: 'text-stat-orange', bg: 'bg-stat-orange/10' },
    { label: 'AI Responses',      value: analytics?.ai_messages     || 0, icon: Bot,            color: 'text-stat-purple', bg: 'bg-stat-purple/10' },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {stats.map((stat, index) => (
        <div key={index} className="rounded-xl border border-border p-4 hover:shadow-sm transition-shadow bg-background">
          <div className="flex items-center justify-between mb-3">
            <div className={cn("p-2 rounded-lg", stat.bg)}>
              <stat.icon size={16} className={stat.color} />
            </div>
          </div>
          <p className={cn("text-2xl font-bold", stat.color)}>
            {stat.value.toLocaleString()}
          </p>
          <span className="text-xs text-muted-foreground font-medium mt-1 block">
            {stat.label}
          </span>
        </div>
      ))}
    </div>
  );
};
