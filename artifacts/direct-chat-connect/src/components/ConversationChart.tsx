import { useState, useRef, useEffect } from 'react';
import { useChartData } from '@/hooks/useChatHistory';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts';
import { TrendingUp, Calendar, BarChart3, Activity, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';

type TimeRange = 'daily' | 'weekly' | 'monthly' | 'custom';

export const ConversationChart = () => {
  const [timeRange, setTimeRange]     = useState<TimeRange>('daily');
  const [chartType, setChartType]     = useState<'area' | 'bar'>('area');
  const [customStart, setCustomStart] = useState('');
  const [customEnd,   setCustomEnd]   = useState('');
  const [pickerOpen,  setPickerOpen]  = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // today as max for both date inputs
  const todayStr = format(new Date(), 'yyyy-MM-dd');

  // close picker when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const { data: chartData, isLoading } = useChartData(timeRange, customStart, customEnd);

  const tabs = [
    { key: 'daily'   as TimeRange, label: 'Daily',   icon: Calendar },
    { key: 'weekly'  as TimeRange, label: 'Weekly',  icon: BarChart3 },
    { key: 'monthly' as TimeRange, label: 'Monthly', icon: TrendingUp },
  ];

  const totalConversations = chartData?.reduce((s, d) => s + d.conversations, 0) || 0;
  const totalMessages      = chartData?.reduce((s, d) => s + d.messages,      0) || 0;
  const avgPerDay          = chartData?.length ? Math.round(totalConversations / chartData.length) : 0;

  const customLabel = customStart && customEnd
    ? `${format(new Date(customStart + 'T00:00:00'), 'MMM d')} – ${format(new Date(customEnd + 'T00:00:00'), 'MMM d, yyyy')}`
    : 'Custom';

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

          <div className="flex items-center gap-1 flex-wrap">
            {/* Daily / Weekly / Monthly tabs */}
            <div className="flex items-center gap-1 p-1 bg-muted/50 rounded-xl">
              {tabs.map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => { setTimeRange(tab.key); setPickerOpen(false); }}
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

            {/* Custom range button + popover */}
            <div className="relative" ref={pickerRef}>
              <button
                onClick={() => {
                  setTimeRange('custom');
                  setPickerOpen((v) => !v);
                }}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all duration-200 border",
                  timeRange === 'custom'
                    ? "bg-background text-foreground shadow-sm border-border"
                    : "bg-muted/50 text-muted-foreground hover:text-foreground border-transparent"
                )}
              >
                <Calendar size={14} />
                {timeRange === 'custom' && customStart && customEnd ? customLabel : 'Custom'}
                <ChevronDown size={12} className={cn("transition-transform", pickerOpen && "rotate-180")} />
              </button>

              {pickerOpen && (
                <div className="absolute right-0 top-full mt-1.5 z-50 bg-card border border-border rounded-xl shadow-xl p-4 w-72">
                  <p className="text-xs font-semibold text-foreground mb-3">Select date range</p>
                  <div className="space-y-3">
                    <div>
                      <label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide mb-1 block">
                        From
                      </label>
                      <input
                        type="date"
                        value={customStart}
                        max={customEnd || todayStr}
                        onChange={(e) => setCustomStart(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg border border-border bg-muted/30 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide mb-1 block">
                        To
                      </label>
                      <input
                        type="date"
                        value={customEnd}
                        min={customStart}
                        max={todayStr}
                        onChange={(e) => setCustomEnd(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg border border-border bg-muted/30 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                      />
                    </div>
                  </div>
                  <div className="flex gap-2 mt-4">
                    <button
                      onClick={() => {
                        setCustomStart('');
                        setCustomEnd('');
                      }}
                      className="flex-1 px-3 py-1.5 rounded-lg border border-border text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Clear
                    </button>
                    <button
                      disabled={!customStart || !customEnd}
                      onClick={() => setPickerOpen(false)}
                      className="flex-1 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-primary/90 transition-colors"
                    >
                      Apply
                    </button>
                  </div>
                </div>
              )}
            </div>
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

        {/* Custom range — waiting for dates */}
        {timeRange === 'custom' && (!customStart || !customEnd) ? (
          <div className="h-[250px] flex items-center justify-center">
            <div className="text-center">
              <Calendar size={40} className="text-muted-foreground/30 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">Select a date range above</p>
              <p className="text-xs text-muted-foreground/60 mt-1">Pick a start and end date to view data</p>
            </div>
          </div>
        ) : isLoading && !chartData?.length ? (
          <div className="h-[250px] flex items-center justify-center">
            <div className="flex flex-col items-center gap-2">
              <div className="w-8 h-8 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
              <p className="text-xs text-muted-foreground">Loading data...</p>
            </div>
          </div>
        ) : chartData && chartData.length > 0 ? (
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
