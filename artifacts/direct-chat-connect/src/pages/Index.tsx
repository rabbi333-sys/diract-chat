import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { AiControlGuide } from '@/components/AiControlGuide';
import { getActiveConnection } from '@/lib/db-config';
import { toast } from 'sonner';
import { SessionList } from '@/components/SessionList';
import { AnalyticsCard } from '@/components/AnalyticsCard';
import { ConversationChart } from '@/components/ConversationChart';
import { SupabaseSettings } from '@/components/SupabaseSettings';
import { HandoffPanel } from '@/components/HandoffPanel';
import { FailedPanel } from '@/components/FailedPanel';
import { PlatformSettings } from '@/components/PlatformSettings';
import { N8nPromptSettings } from '@/components/N8nPromptSettings';
import OrdersPanel from '@/components/OrdersPanel';
import OrderAnalytics from '@/components/OrderAnalytics';
import WebhookSettings from '@/components/WebhookSettings';
import { useGlobalAiControl } from '@/hooks/useAiControl';
import { ThemeToggle } from '@/components/ThemeToggle';
import { useNotifications } from '@/hooks/useNotifications';
import { useTeamRole } from '@/hooks/useTeamRole';
import { useLanguage } from '@/contexts/LanguageContext';
import {
  BarChart3, MessageSquare, Settings, Menu, X, HandMetal,
  AlertOctagon, ShoppingBag, Bell, BellOff, Volume2, VolumeX,
  Bot, ChevronRight, ArrowLeft, Globe, Webhook, Database, ShieldAlert,
  Power, Play, Loader2, List,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const NAV_PERM_KEY: Record<string, string> = {
  'Overview': 'overview',
  'Messages': 'messages',
  'Handoff': 'handoff',
  'Failed': 'failed',
  'Orders': 'orders',
  'n8n Prompt': 'n8n_prompt',
};

const allNavItems = [
  { icon: BarChart3, label: 'Overview' },
  { icon: MessageSquare, label: 'Messages' },
  { icon: HandMetal, label: 'Handoff', badgeKey: 'handoff' as const },
  { icon: AlertOctagon, label: 'Failed', badgeKey: 'failed' as const },
  { icon: ShoppingBag, label: 'Orders', badgeKey: 'orders' as const },
  { icon: Bot, label: 'n8n Prompt' },
  { icon: Settings, label: 'Settings' },
];

const NAV_LABEL_KEYS: Record<string, 'overview'|'messages'|'handoff'|'failed'|'orders'|'n8nPrompt'|'settings'> = {
  'Overview': 'overview',
  'Messages': 'messages',
  'Handoff': 'handoff',
  'Failed': 'failed',
  'Orders': 'orders',
  'n8n Prompt': 'n8nPrompt',
  'Settings': 'settings',
};

const Index = () => {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const { user, isAdmin, permissions, notAuthorized, displayName, initials, loading: roleLoading } = useTeamRole();

  const [activeNav, setActiveNav] = useState('Messages');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<string | null>(null);
  const [ordersView, setOrdersView] = useState<'list' | 'analytics'>('list');
  const [aiEdgeFnUrl, setAiEdgeFnUrl] = useState('');
  const { enabled: notifEnabled, soundEnabled, toggleEnabled: toggleNotif, toggleSound, counts, clearCount } = useNotifications();
  const { globalOn, toggle: toggleGlobalAi, isPending: globalAiPending } = useGlobalAiControl();

  useEffect(() => {
    if (settingsSection !== 'ai-control') return;
    const active = getActiveConnection();
    if (active?.url && (!active.dbType || active.dbType === 'supabase')) {
      setAiEdgeFnUrl(`${active.url.replace(/\/$/, '')}/functions/v1/check-ai-status`);
    } else {
      setAiEdgeFnUrl('https://<project-ref>.supabase.co/functions/v1/check-ai-status');
    }
  }, [settingsSection]);

  const navItems = roleLoading
    ? allNavItems
    : allNavItems.filter((item) => {
        if (item.label === 'Settings') return isAdmin;
        if (isAdmin) return true;
        const key = NAV_PERM_KEY[item.label];
        return key ? permissions.includes(key) : false;
      });

  useEffect(() => {
    if (!roleLoading) {
      const isVisible = navItems.some((item) => item.label === activeNav);
      if (!isVisible && navItems.length > 0) {
        setActiveNav(navItems[0].label);
      }
    }
  }, [roleLoading, isAdmin, permissions.join(',')]);

  const handleNavClick = (label: string, badgeKey?: 'handoff' | 'failed' | 'orders') => {
    setActiveNav(label);
    setSidebarOpen(false);
    if (badgeKey) clearCount(badgeKey);
  };

  const BadgeDot = ({ count }: { count: number }) => {
    if (count <= 0) return null;
    return (
      <span className="ml-auto min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold px-1 animate-in zoom-in-50 duration-300">
        {count > 99 ? '99+' : count}
      </span>
    );
  };

  // Render-time permission guard — used both for nav filtering AND section body rendering.
  // Settings has no permission key (always admin-only) and falls through to `false`.
  const canView = (label: string): boolean => {
    if (roleLoading) return false;
    if (isAdmin) return true;
    const key = NAV_PERM_KEY[label];
    return key ? permissions.includes(key) : false;
  };

  const avatarUrl = user?.user_metadata?.avatar_url as string | undefined;

  const SidebarProfileNav = ({ mobile = false }: { mobile?: boolean }) => (
    <button
      onClick={() => { navigate('/profile'); setSidebarOpen(false); }}
      data-testid="button-profile-sidebar"
      className={cn(
        'w-full flex items-center gap-2.5 px-3 rounded-xl transition-all group',
        'hover:bg-muted border border-transparent hover:border-border/50',
        mobile ? 'py-2.5' : 'py-2'
      )}
    >
      {/* Avatar */}
      <div className={cn(
        'rounded-xl overflow-hidden bg-primary/10 flex items-center justify-center flex-shrink-0 ring-2 ring-border/30 group-hover:ring-primary/20 transition-all',
        mobile ? 'w-10 h-10' : 'w-8 h-8'
      )}>
        {avatarUrl ? (
          <img src={avatarUrl} alt="Profile" className="w-full h-full object-cover" />
        ) : (
          <span className={cn('font-bold text-primary', mobile ? 'text-xs' : 'text-[10px]')}>
            {initials}
          </span>
        )}
      </div>

      {/* Name + label */}
      <div className="flex-1 text-left min-w-0">
        <p className={cn('font-semibold text-foreground truncate leading-tight', mobile ? 'text-sm' : 'text-xs')}>
          {displayName || t('profile')}
        </p>
        <p className="text-[10px] text-muted-foreground leading-tight">{t('accountSettings')}</p>
      </div>

      {/* Arrow */}
      <ChevronRight size={13} className="text-muted-foreground/40 group-hover:text-muted-foreground flex-shrink-0 transition-colors" />
    </button>
  );

  // Non-owner, non-invited user: show access-denied screen
  if (!roleLoading && notAuthorized) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="text-center space-y-4 max-w-xs">
          <div className="w-14 h-14 rounded-full bg-muted flex items-center justify-center mx-auto">
            <ShieldAlert size={26} className="text-muted-foreground/60" />
          </div>
          <div>
            <p className="text-base font-semibold text-foreground">{t('accessNotGranted')}</p>
            <p className="text-sm text-muted-foreground mt-1">
              {t('accessNotGrantedSub')}
            </p>
          </div>
          <button
            onClick={() => { supabase.auth.signOut(); navigate('/'); }}
            className="text-sm text-primary hover:underline"
          >
            {t('signOut')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex bg-background">
      {/* Mobile Header */}
      <div className="md:hidden fixed top-0 left-0 right-0 h-14 bg-background border-b border-border flex items-center justify-between px-4 z-50">
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="p-2 rounded-lg hover:bg-muted relative"
        >
          {sidebarOpen ? <X size={20} /> : <Menu size={20} />}
          {!sidebarOpen && (counts.handoff + counts.failed + counts.orders) > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] flex items-center justify-center rounded-full bg-destructive text-destructive-foreground text-[9px] font-bold px-0.5">
              {counts.handoff + counts.failed + counts.orders}
            </span>
          )}
        </button>
        <h1 className="text-base font-bold text-foreground">
          Chat <span className="text-primary">Monitor</span>
        </h1>
        <div className="flex items-center gap-2">
          <button
            onClick={toggleGlobalAi}
            disabled={globalAiPending}
            data-testid="button-global-ai-toggle"
            className={cn(
              'flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[11px] font-bold transition-all duration-200 select-none disabled:opacity-60',
              globalOn
                ? 'text-emerald-700 dark:text-emerald-300 bg-emerald-500/15 border border-emerald-500/30 hover:bg-emerald-500/25'
                : 'text-red-600 dark:text-red-400 bg-red-500/10 border border-red-400/30 hover:bg-red-500/20'
            )}
          >
            {globalAiPending ? <Loader2 size={12} className="animate-spin" /> : globalOn ? <Power size={12} /> : <Play size={12} />}
            {globalOn ? 'Shutdown' : 'Start'}
          </button>
          <ThemeToggle />
        </div>
      </div>

      {/* Mobile Sidebar Overlay */}
      {sidebarOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/50 z-40 pt-14"
          onClick={() => setSidebarOpen(false)}
        >
          <aside
            className="w-64 h-full bg-background border-r border-border flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <nav className="flex-1 px-3 py-4 space-y-1">
              {navItems.map((item) => (
                <button
                  key={item.label}
                  onClick={() => handleNavClick(item.label, item.badgeKey)}
                  className={cn(
                    "w-full flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-medium transition-colors",
                    activeNav === item.label
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                >
                  <item.icon size={20} />
                  {t(NAV_LABEL_KEYS[item.label])}
                  {item.badgeKey && <BadgeDot count={counts[item.badgeKey]} />}
                </button>
              ))}
            </nav>
            <div className="px-3 pb-4 space-y-1 border-t border-border pt-3">
              <SidebarProfileNav mobile />
            </div>
          </aside>
        </div>
      )}

      {/* Desktop Sidebar */}
      <aside className="hidden md:flex w-[180px] border-r border-border flex-col bg-background flex-shrink-0">
        <div className="p-5 pb-8">
          <h1 className="text-lg font-bold text-foreground">
            Chat <span className="text-primary">Monitor</span>
          </h1>
        </div>

        <nav className="flex-1 px-3 space-y-1">
          {navItems.map((item) => (
            <button
              key={item.label}
              onClick={() => handleNavClick(item.label, item.badgeKey)}
              className={cn(
                "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors relative",
                activeNav === item.label
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <item.icon size={18} />
              <span className="flex-1 text-left">{t(NAV_LABEL_KEYS[item.label])}</span>
              {item.badgeKey && counts[item.badgeKey] > 0 && (
                <span className={cn(
                  "min-w-[18px] h-[18px] flex items-center justify-center rounded-full text-[10px] font-bold px-1 animate-pulse",
                  activeNav === item.label
                    ? "bg-primary-foreground text-primary"
                    : "bg-destructive text-destructive-foreground"
                )}>
                  {counts[item.badgeKey] > 99 ? '99+' : counts[item.badgeKey]}
                </span>
              )}
            </button>
          ))}
        </nav>

        {/* Bottom: Profile nav + Theme */}
        <div className="px-3 pb-4 border-t border-border pt-3 space-y-1">
          <SidebarProfileNav />
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col pt-14 md:pt-0 overflow-hidden relative">
        {/* Desktop top-right toolbar: AI toggle + Theme — hidden on Orders page */}
        <div className={cn("hidden items-center gap-2 absolute top-3 right-4 z-10", activeNav !== 'Orders' && "md:flex")}>
          <button
            onClick={toggleGlobalAi}
            disabled={globalAiPending}
            data-testid="button-global-ai-toggle-desktop"
            className={cn(
              'flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[11px] font-bold transition-all duration-200 select-none disabled:opacity-60',
              globalOn
                ? 'text-emerald-700 dark:text-emerald-300 bg-emerald-500/15 border border-emerald-500/30 hover:bg-emerald-500/25'
                : 'text-red-600 dark:text-red-400 bg-red-500/10 border border-red-400/30 hover:bg-red-500/20'
            )}
          >
            {globalAiPending ? <Loader2 size={12} className="animate-spin" /> : globalOn ? <Power size={12} /> : <Play size={12} />}
            {globalOn ? 'Shutdown' : 'Start'}
          </button>
          <ThemeToggle />
        </div>

        {/* Loading skeleton while role/permissions resolve */}
        {roleLoading && (
          <main className="flex-1 overflow-auto p-4 md:p-6 space-y-5">
            <div className="h-6 w-32 rounded-lg bg-muted animate-pulse" />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-24 rounded-xl bg-muted animate-pulse" />
              ))}
            </div>
            <div className="h-48 rounded-xl bg-muted animate-pulse" />
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-14 rounded-xl bg-muted animate-pulse" />
              ))}
            </div>
          </main>
        )}

        {/* Viewer with no permitted sections — show an info state */}
        {!roleLoading && !isAdmin && navItems.length === 0 && (
          <main className="flex-1 flex items-center justify-center p-6">
            <div className="text-center space-y-3 max-w-xs">
              <ShieldAlert size={32} className="text-muted-foreground/40 mx-auto" />
              <p className="text-sm font-semibold text-foreground">{t('noSections')}</p>
              <p className="text-xs text-muted-foreground">
                {t('noSectionsSub')}
              </p>
            </div>
          </main>
        )}

        {activeNav === 'Overview' && canView('Overview') && (
          <main className="flex-1 flex flex-col overflow-auto">
            <div className="p-4 md:p-6 space-y-6">
              <h2 className="text-lg md:text-xl font-bold text-foreground">{t('overviewTitle')}</h2>
              <AnalyticsCard />
              <ConversationChart />
            </div>
          </main>
        )}

        {/* Messages Page */}
        {activeNav === 'Messages' && canView('Messages') && (
          <div className="flex-1 flex flex-col bg-background overflow-hidden">
            <div className="p-3 md:p-4 pb-2">
              <h2 className="text-lg md:text-xl font-bold text-foreground">{t('messagesTitle')}</h2>
            </div>
            <SessionList />
          </div>
        )}

        {/* Handoff Page */}
        {activeNav === 'Handoff' && canView('Handoff') && (
          <main className="flex-1 flex flex-col overflow-hidden">
            <div className="flex flex-col flex-1 min-h-0 p-4 md:p-6 max-w-3xl w-full">
              <h2 className="text-lg md:text-xl font-bold text-foreground mb-4 flex-shrink-0">{t('handoffTitle')}</h2>
              <HandoffPanel />
            </div>
          </main>
        )}

        {/* Failed Automations Page */}
        {activeNav === 'Failed' && canView('Failed') && (
          <main className="flex-1 flex flex-col overflow-hidden">
            <div className="flex flex-col flex-1 min-h-0 p-4 md:p-6 max-w-3xl w-full">
              <h2 className="text-lg md:text-xl font-bold text-foreground mb-4 flex-shrink-0">{t('failedTitle')}</h2>
              <FailedPanel />
            </div>
          </main>
        )}

        {/* Orders Page */}
        {activeNav === 'Orders' && canView('Orders') && (
          <main className="flex-1 flex flex-col overflow-hidden">
            <div className="flex flex-col h-full p-4 md:p-6">
              {/* Header with tab toggle */}
              <div className="flex items-center justify-between mb-4 flex-shrink-0">
                <h2 className="text-lg md:text-xl font-bold text-foreground">{t('ordersTitle')}</h2>
                <div className="flex items-center bg-muted/60 rounded-xl p-1 border border-border/50 gap-0.5">
                  <button
                    onClick={() => setOrdersView('list')}
                    className={cn(
                      "flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg transition-all",
                      ordersView === 'list'
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <List size={13} /> Orders
                  </button>
                  <button
                    onClick={() => setOrdersView('analytics')}
                    className={cn(
                      "flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg transition-all",
                      ordersView === 'analytics'
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <BarChart3 size={13} /> Analytics
                  </button>
                </div>
              </div>

              {/* List view */}
              {ordersView === 'list' && (
                <div className="flex-1 overflow-hidden">
                  <OrdersPanel />
                </div>
              )}

              {/* Analytics view */}
              {ordersView === 'analytics' && (
                <div className="flex-1 overflow-auto">
                  <OrderAnalytics />
                </div>
              )}
            </div>
          </main>
        )}

        {/* n8n Prompt Page */}
        {activeNav === 'n8n Prompt' && canView('n8n Prompt') && (
          <main className="flex-1 overflow-auto">
            <div className="p-4 md:p-6 max-w-2xl">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 rounded-xl bg-violet-500/10 flex items-center justify-center">
                  <Bot size={20} className="text-violet-500" />
                </div>
                <div>
                  <h2 className="text-lg md:text-xl font-bold text-foreground">{t('n8nPromptTitle')}</h2>
                  <p className="text-sm text-muted-foreground">{t('n8nPromptSub')}</p>
                </div>
              </div>
              <N8nPromptSettings />
            </div>
          </main>
        )}

        {/* Settings Page — admin only */}
        {activeNav === 'Settings' && isAdmin && (
          <main className="flex-1 overflow-auto">
            {settingsSection === null ? (
              <div className="p-4 md:p-6 max-w-lg">
                <h2 className="text-lg md:text-xl font-bold text-foreground mb-6">{t('settingsTitle')}</h2>
                <div className="rounded-2xl border border-border overflow-hidden divide-y divide-border">
                  {[
                    {
                      key: 'notifications',
                      icon: Bell,
                      iconBg: 'bg-primary/10',
                      iconColor: 'text-primary',
                      label: t('notifications'),
                      sub: t('notificationsSub'),
                      active: notifEnabled,
                    },
                    {
                      key: 'platform',
                      icon: Globe,
                      iconBg: 'bg-blue-500/10',
                      iconColor: 'text-blue-500',
                      label: t('platformConnections'),
                      sub: t('platformConnectionsSub'),
                    },
                    {
                      key: 'webhook',
                      icon: Webhook,
                      iconBg: 'bg-amber-500/10',
                      iconColor: 'text-amber-500',
                      label: t('webhookApi'),
                      sub: t('webhookApiSub'),
                    },
                    {
                      key: 'database',
                      icon: Database,
                      iconBg: 'bg-violet-500/10',
                      iconColor: 'text-violet-500',
                      label: t('database'),
                      sub: t('databaseSub'),
                    },
                    {
                      key: 'ai-control',
                      icon: Bot,
                      iconBg: 'bg-emerald-500/10',
                      iconColor: 'text-emerald-500',
                      label: t('aiControlSettings'),
                      sub: t('aiControlSettingsSub'),
                    },
                  ].map((item) => (
                    <button
                      key={item.key}
                      onClick={() => setSettingsSection(item.key)}
                      data-testid={`settings-menu-${item.key}`}
                      className="w-full flex items-center gap-4 px-5 py-4 bg-card hover:bg-muted/40 transition-colors text-left group"
                    >
                      <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0', item.iconBg)}>
                        <item.icon size={18} className={item.iconColor} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-foreground">{item.label}</p>
                        <p className="text-[11px] text-muted-foreground mt-0.5">{item.sub}</p>
                      </div>
                      {'active' in item && (
                        <span className={cn(
                          'text-[10px] font-semibold px-2 py-0.5 rounded-full mr-1',
                          item.active ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                        )}>
                          {item.active ? t('on') : t('off')}
                        </span>
                      )}
                      <ChevronRight size={16} className="text-muted-foreground group-hover:text-foreground transition-colors flex-shrink-0" />
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="p-4 md:p-6 max-w-2xl">
                <button
                  onClick={() => setSettingsSection(null)}
                  className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-5 transition-colors"
                  data-testid="button-settings-back"
                >
                  <ArrowLeft size={16} /> {t('backToSettings')}
                </button>

                {settingsSection === 'notifications' && (
                  <div className="space-y-4">
                    <h2 className="text-lg font-bold text-foreground">{t('notifications')}</h2>
                    <div className="space-y-3">
                      <div className="flex items-center justify-between p-4 bg-card border border-border rounded-xl">
                        <div className="flex items-center gap-3">
                          {notifEnabled ? <Bell size={18} className="text-primary" /> : <BellOff size={18} className="text-muted-foreground" />}
                          <div>
                            <p className="text-sm font-medium text-foreground">{t('browserNotifications')}</p>
                            <p className="text-[11px] text-muted-foreground">{t('browserNotificationsSub')}</p>
                          </div>
                        </div>
                        <button
                          onClick={toggleNotif}
                          data-testid="toggle-notifications"
                          className={cn('relative w-11 h-6 rounded-full transition-colors', notifEnabled ? 'bg-primary' : 'bg-muted-foreground/30')}
                        >
                          <span className={cn('absolute top-0.5 w-5 h-5 rounded-full bg-background shadow transition-transform', notifEnabled ? 'translate-x-[22px]' : 'translate-x-0.5')} />
                        </button>
                      </div>
                      <div className={cn('flex items-center justify-between p-4 bg-card border border-border rounded-xl transition-opacity', !notifEnabled && 'opacity-50 pointer-events-none')}>
                        <div className="flex items-center gap-3">
                          {soundEnabled ? <Volume2 size={18} className="text-primary" /> : <VolumeX size={18} className="text-muted-foreground" />}
                          <div>
                            <p className="text-sm font-medium text-foreground">{t('soundAlerts')}</p>
                            <p className="text-[11px] text-muted-foreground">{t('soundAlertsSub')}</p>
                          </div>
                        </div>
                        <button
                          onClick={toggleSound}
                          data-testid="toggle-sound"
                          className={cn('relative w-11 h-6 rounded-full transition-colors', soundEnabled ? 'bg-primary' : 'bg-muted-foreground/30')}
                        >
                          <span className={cn('absolute top-0.5 w-5 h-5 rounded-full bg-background shadow transition-transform', soundEnabled ? 'translate-x-[22px]' : 'translate-x-0.5')} />
                        </button>
                      </div>
                      <p className="text-[11px] text-muted-foreground px-1">
                        {t('notifInfo')}
                      </p>
                    </div>
                  </div>
                )}

                {settingsSection === 'platform' && (
                  <div className="space-y-4">
                    <h2 className="text-lg font-bold text-foreground">{t('platformHeader')}</h2>
                    <PlatformSettings />
                  </div>
                )}

                {settingsSection === 'webhook' && (
                  <div className="space-y-4">
                    <h2 className="text-lg font-bold text-foreground">{t('webhookHeader')}</h2>
                    <WebhookSettings />
                  </div>
                )}

                {settingsSection === 'database' && (
                  <div className="space-y-4">
                    <h2 className="text-lg font-bold text-foreground">{t('databaseHeader')}</h2>
                    <p className="text-sm text-muted-foreground -mt-2">{t('databaseSettingsSub')}</p>
                    <SupabaseSettings />
                  </div>
                )}

                {settingsSection === 'ai-control' && (
                  <div className="space-y-5">
                    <h2 className="text-lg font-bold text-foreground">{t('aiControlSettings')}</h2>
                    <AiControlGuide
                      defaultDbType={getActiveConnection()?.dbType ?? 'supabase'}
                      edgeFnUrl={aiEdgeFnUrl}
                    />
                  </div>
                )}
              </div>
            )}
          </main>
        )}

        {/* Fallback for restricted sections */}
        {!navItems.some((item) => item.label === activeNav) && !roleLoading && (
          <main className="flex-1 flex items-center justify-center">
            <div className="text-center space-y-2">
              <p className="text-muted-foreground text-sm">{t('noAccess')}</p>
            </div>
          </main>
        )}
      </div>
    </div>
  );
};

export default Index;
