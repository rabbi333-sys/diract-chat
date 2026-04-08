import { useState } from 'react';
import { useChartData } from '@/hooks/useChatHistory';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts';
import { TrendingUp, Calendar, BarChart3, Activity } from 'lucide-react';
import { cn } from '@/lib/utils';

type TimeRange = 'daily' | 'weekly' | 'monthly';

export const ConversationChart = () => {
  const [timeRange, setTimeRange] = useState<TimeRange>('daily');
  const [chartType, setChartType] = useState<'area' | 'bar'>('area');

  const { data: chartData, isLoading } = useChartData(timeRange);

  const tabs = [
    { key: 'daily'   as TimeRange, label: 'Daily',   icon: Calendar },
    { key: 'weekly'  as TimeRange, label: 'Weekly',  icon: BarChart3 },
    { key: 'monthly' as TimeRange, label: 'Monthly', icon: TrendingUp },
  ];

  const totalConversations = chartData?.reduce((s, d) => s + d.conversations, 0) || 0;
  const totalMessages      = chartData?.reduce((s, d) => s + d.messages,      0) || 0;
  const avgPerDay          = chartData?.length ? Math.round(totalConversations / chartData.length) : 0;

  return (
    <div className="rounded-2xl border border-border bg-gradient-to-br from-card via-card to-muted/20 overflow-hidden">
      {/* Header */}
      <div className="p-5 pb-4 border-b border-border/50">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 border border-primary/20">
              <Activity size={20} className="text-primary" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-foreground">Conversation Activity</h3>
              <p className="text-xs text-muted-foreground mt-0.5">Messages & conversations over time</p>
            </div>
          </div>

          <div className="flex items-center gap-1 p-1 bg-muted/50 rounded-xl">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setTimeRange(tab.key)}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200",
                  timeRange === tab.key
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <tab.icon size={14} />
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Summary Stats */}
        <div className="grid grid-cols-3 gap-3 mt-4">
          <div className="p-3 rounded-xl bg-gradient-to-br from-stat-blue/10 to-transparent border border-stat-blue/20">
            <p className="text-lg font-bold text-stat-blue">{totalConversations}</p>
            <p className="text-[10px] text-muted-foreground font-medium">Total Conversations</p>
          </div>
          <div className="p-3 rounded-xl bg-gradient-to-br from-stat-green/10 to-transparent border border-stat-green/20">
            <p className="text-lg font-bold text-stat-green">{totalMessages}</p>
            <p className="text-[10px] text-muted-foreground font-medium">Total Messages</p>
          </div>
          <div className="p-3 rounded-xl bg-gradient-to-br from-stat-purple/10 to-transparent border border-stat-purple/20">
            <p className="text-lg font-bold text-stat-purple">{avgPerDay}</p>
            <p className="text-[10px] text-muted-foreground font-medium">Avg / Day</p>
          </div>
        </div>
      </div>

      {/* Chart Area */}
      <div className="p-4 pt-3">
        <div className="flex justify-end mb-3">
          <div className="flex items-center gap-1 p-0.5 bg-muted/30 rounded-lg">
            <button
              onClick={() => setChartType('area')}
              className={cn("p-1.5 rounded-md transition-all", chartType === 'area' ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}
            ><TrendingUp size={14} /></button>
            <button
              onClick={() => setChartType('bar')}
              className={cn("p-1.5 rounded-md transition-all", chartType === 'bar' ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}
            ><BarChart3 size={14} /></button>
          </div>
        </div>

        {isLoading ? (
          <div className="h-[250px] flex items-center justify-center">
            <div className="flex flex-col items-center gap-2">
              <div className="w-8 h-8 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
              <p className="text-xs text-muted-foreground">Loading data...</p>
            </div>
          </div>
        ) : chartData && chartData.some((d) => d.conversations > 0 || d.messages > 0) ? (
          <div className="h-[250px]">
            <ResponsiveContainer width="100%" height="100%">
              {chartType === 'area' ? (
                <AreaChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="conversationGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="messageGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--stat-green))" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="hsl(var(--stat-green))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{ backgroundColor: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: '12px', boxShadow: '0 10px 40px -10px hsl(var(--foreground) / 0.2)', padding: '10px 14px' }}
                    labelStyle={{ color: 'hsl(var(--foreground))', fontWeight: 600, marginBottom: 4 }}
                    itemStyle={{ color: 'hsl(var(--muted-foreground))', fontSize: 12 }}
                  />
                  <Area type="monotone" dataKey="messages"      name="Messages"      stroke="hsl(var(--stat-green))" strokeWidth={2} fill="url(#messageGradient)" />
                  <Area type="monotone" dataKey="conversations" name="Conversations" stroke="hsl(var(--primary))"    strokeWidth={2} fill="url(#conversationGradient)" />
                </AreaChart>
              ) : (
                <BarChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{ backgroundColor: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: '12px', boxShadow: '0 10px 40px -10px hsl(var(--foreground) / 0.2)', padding: '10px 14px' }}
                    labelStyle={{ color: 'hsl(var(--foreground))', fontWeight: 600, marginBottom: 4 }}
                    itemStyle={{ color: 'hsl(var(--muted-foreground))', fontSize: 12 }}
                  />
                  <Bar dataKey="conversations" name="Conversations" fill="hsl(var(--primary))"    radius={[4, 4, 0, 0]} />
                  <Bar dataKey="messages"      name="Messages"      fill="hsl(var(--stat-green))" radius={[4, 4, 0, 0]} />
                </BarChart>
              )}
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="h-[250px] flex items-center justify-center">
            <div className="text-center">
              <Activity size={40} className="text-muted-foreground/30 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No data available</p>
              <p className="text-xs text-muted-foreground/60 mt-1">Connect your database in Database Settings</p>
            </div>
          </div>
        )}

        <div className="flex items-center justify-center gap-6 mt-3 pt-3 border-t border-border/50">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-primary" />
            <span className="text-xs text-muted-foreground">Conversations</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-stat-green" />
            <span className="text-xs text-muted-foreground">Messages</span>
          </div>
        </div>
      </div>
    </div>
  );
};
