import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Facebook, MessageCircle, Instagram, Check, Loader2, Eye, EyeOff, Trash2, Plus, Shield, Tag, ChevronDown, ChevronUp } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  usePlatformConnections,
  useAddPlatformConnection,
  useUpdatePlatformConnection,
  useDeletePlatformConnection,
  PlatformConnection,
} from '@/hooks/usePlatformConnections';

type Platform = 'facebook' | 'whatsapp' | 'instagram';

// ─── Platform config ───────────────────────────────────────────────────────────
const PLATFORMS: {
  id: Platform;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  color: string;
  bgColor: string;
  borderColor: string;
  hint: string;
  fields: { key: 'page_id' | 'phone_number_id'; label: string; placeholder: string }[];
}[] = [
  {
    id: 'facebook',
    label: 'Facebook',
    icon: Facebook,
    color: 'text-blue-600',
    bgColor: 'bg-blue-500/10',
    borderColor: 'border-blue-500/30',
    hint: 'Meta Developer Portal → Apps → Access Tokens',
    fields: [{ key: 'page_id', label: 'Page ID', placeholder: '123456789...' }],
  },
  {
    id: 'whatsapp',
    label: 'WhatsApp',
    icon: MessageCircle,
    color: 'text-green-600',
    bgColor: 'bg-green-500/10',
    borderColor: 'border-green-500/30',
    hint: 'Meta Developer Portal → WhatsApp → Getting Started',
    fields: [{ key: 'phone_number_id', label: 'Phone Number ID', placeholder: '123456789...' }],
  },
  {
    id: 'instagram',
    label: 'Instagram',
    icon: Instagram,
    color: 'text-pink-600',
    bgColor: 'bg-pink-500/10',
    borderColor: 'border-pink-500/30',
    hint: 'Meta Developer Portal → Instagram → Basic Display API',
    fields: [{ key: 'page_id', label: 'Instagram Business ID', placeholder: '17841400...' }],
  },
];

// ─── Shared form state ─────────────────────────────────────────────────────────
interface AccountFormState {
  label: string;
  access_token: string;
  page_id: string;
  phone_number_id: string;
  is_active: boolean;
  showToken: boolean;
}

const emptyForm = (): AccountFormState => ({
  label: '',
  access_token: '',
  page_id: '',
  phone_number_id: '',
  is_active: true,
  showToken: false,
});

const connToForm = (c: PlatformConnection): AccountFormState => ({
  label: c.label ?? '',
  access_token: c.access_token,
  page_id: c.page_id ?? '',
  phone_number_id: c.phone_number_id ?? '',
  is_active: c.is_active,
  showToken: false,
});

// ─── Account card (existing) ───────────────────────────────────────────────────
const AccountCard = ({
  account,
  platform,
}: {
  account: PlatformConnection;
  platform: typeof PLATFORMS[number];
}) => {
  const updateMutation = useUpdatePlatformConnection();
  const deleteMutation = useDeletePlatformConnection();
  const [form, setForm] = useState<AccountFormState>(() => connToForm(account));
  const [expanded, setExpanded] = useState(false);

  const set = useCallback(<K extends keyof AccountFormState>(k: K, v: AccountFormState[K]) =>
    setForm((prev) => ({ ...prev, [k]: v })), []);

  const handleSave = () => {
    updateMutation.mutate(
      {
        id: account.id,
        label: form.label.trim() || null,
        access_token: form.access_token.trim(),
        page_id: form.page_id.trim() || null,
        phone_number_id: form.phone_number_id.trim() || null,
        is_active: form.is_active,
      },
      {
        onSuccess: () => { setExpanded(false); toast.success('Account updated!'); },
        onError: (e: Error) => toast.error(e.message),
      }
    );
  };

  const handleDelete = () => {
    deleteMutation.mutate(account.id, {
      onSuccess: () => toast.success('Account removed'),
      onError: (e: Error) => toast.error(e.message),
    });
  };

  const displayName = account.label || platform.label + ' Account';
  const secondaryId = account.page_id || account.phone_number_id;

  return (
    <div className={cn(
      "rounded-xl border bg-background transition-all",
      account.is_active ? "border-border" : "border-border/50 opacity-70"
    )}>
      {/* Collapsed header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/30 rounded-xl transition-colors"
        data-testid={`account-card-${account.id}`}
      >
        <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0", platform.bgColor)}>
          <platform.icon size={16} className={platform.color} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate">{displayName}</p>
          {secondaryId && (
            <p className="text-[10px] text-muted-foreground font-mono truncate">ID: {secondaryId}</p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {account.is_active
            ? <span className="text-[10px] font-medium text-emerald-600 bg-emerald-500/10 px-1.5 py-0.5 rounded-full">Active</span>
            : <span className="text-[10px] font-medium text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full">Inactive</span>
          }
          {expanded ? <ChevronUp size={14} className="text-muted-foreground" /> : <ChevronDown size={14} className="text-muted-foreground" />}
        </div>
      </button>

      {/* Expanded edit form */}
      {expanded && (
        <div className="px-4 pb-4 pt-0 space-y-3 border-t border-border/50 mt-0">
          {/* Label */}
          <div className="space-y-1 pt-3">
            <Label className="text-[11px] font-medium flex items-center gap-1">
              <Tag size={11} /> Account Label
            </Label>
            <Input
              placeholder={`e.g. Olpobd ${platform.label} Page 1`}
              value={form.label}
              onChange={(e) => set('label', e.target.value)}
              className="h-8 text-sm"
              data-testid={`input-label-${account.id}`}
            />
          </div>

          {/* Access Token */}
          <div className="space-y-1">
            <Label className="text-[11px] font-medium">Access Token</Label>
            <div className="relative">
              <Input
                type={form.showToken ? 'text' : 'password'}
                placeholder="EAAxxxxxxx..."
                value={form.access_token}
                onChange={(e) => set('access_token', e.target.value)}
                className="pr-9 h-8 text-sm font-mono"
                data-testid={`input-token-${account.id}`}
              />
              <button
                type="button"
                onClick={() => set('showToken', !form.showToken)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {form.showToken ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>
          </div>

          {/* Platform-specific ID fields */}
          {platform.fields.map((field) => (
            <div key={field.key} className="space-y-1">
              <Label className="text-[11px] font-medium">{field.label}</Label>
              <Input
                placeholder={field.placeholder}
                value={field.key === 'page_id' ? form.page_id : form.phone_number_id}
                onChange={(e) => set(field.key === 'page_id' ? 'page_id' : 'phone_number_id', e.target.value)}
                className="h-8 text-sm"
                data-testid={`input-${field.key}-${account.id}`}
              />
            </div>
          ))}

          {/* Active toggle */}
          <div className="flex items-center justify-between">
            <Label className="text-[11px] font-medium">Active</Label>
            <Switch
              checked={form.is_active}
              onCheckedChange={(v) => set('is_active', v)}
              data-testid={`switch-active-${account.id}`}
            />
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 pt-1">
            <Button
              size="sm"
              className="h-8"
              onClick={handleSave}
              disabled={!form.access_token.trim() || updateMutation.isPending}
              data-testid={`button-save-${account.id}`}
            >
              {updateMutation.isPending
                ? <Loader2 size={13} className="animate-spin mr-1" />
                : <Check size={13} className="mr-1" />}
              Save
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8"
              onClick={() => { setForm(connToForm(account)); setExpanded(false); }}
            >
              Cancel
            </Button>
            <div className="flex-1" />
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-destructive hover:bg-destructive/10"
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
              data-testid={`button-delete-${account.id}`}
            >
              {deleteMutation.isPending ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── New account form ──────────────────────────────────────────────────────────
const NewAccountForm = ({
  platform,
  onSaved,
  onCancel,
}: {
  platform: typeof PLATFORMS[number];
  onSaved: () => void;
  onCancel: () => void;
}) => {
  const addMutation = useAddPlatformConnection();
  const [form, setForm] = useState<AccountFormState>(emptyForm);

  const set = useCallback(<K extends keyof AccountFormState>(k: K, v: AccountFormState[K]) =>
    setForm((prev) => ({ ...prev, [k]: v })), []);

  const handleAdd = () => {
    addMutation.mutate(
      {
        platform: platform.id,
        label: form.label.trim() || null,
        access_token: form.access_token.trim(),
        page_id: form.page_id.trim() || null,
        phone_number_id: form.phone_number_id.trim() || null,
        is_active: form.is_active,
      },
      {
        onSuccess: () => { onSaved(); toast.success(`${platform.label} account added!`); },
        onError: (e: Error) => toast.error(e.message),
      }
    );
  };

  return (
    <div className={cn("rounded-xl border-2 border-dashed p-4 space-y-3 bg-muted/20", platform.borderColor)}>
      <div className="flex items-center gap-2 mb-1">
        <div className={cn("w-6 h-6 rounded-md flex items-center justify-center", platform.bgColor)}>
          <platform.icon size={13} className={platform.color} />
        </div>
        <span className="text-xs font-semibold text-foreground">New {platform.label} Account</span>
      </div>

      {/* Label */}
      <div className="space-y-1">
        <Label className="text-[11px] font-medium flex items-center gap-1">
          <Tag size={11} /> Account Label <span className="text-muted-foreground">(optional)</span>
        </Label>
        <Input
          placeholder={`e.g. Olpobd ${platform.label} Page 1`}
          value={form.label}
          onChange={(e) => set('label', e.target.value)}
          className="h-8 text-sm"
          data-testid="input-new-label"
        />
      </div>

      {/* Access Token */}
      <div className="space-y-1">
        <Label className="text-[11px] font-medium">Access Token <span className="text-destructive">*</span></Label>
        <div className="relative">
          <Input
            type={form.showToken ? 'text' : 'password'}
            placeholder="EAAxxxxxxx..."
            value={form.access_token}
            onChange={(e) => set('access_token', e.target.value)}
            className="pr-9 h-8 text-sm font-mono"
            data-testid="input-new-token"
            autoFocus
          />
          <button
            type="button"
            onClick={() => set('showToken', !form.showToken)}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            {form.showToken ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
        </div>
        <p className="text-[10px] text-muted-foreground">{platform.hint}</p>
      </div>

      {/* Platform-specific ID */}
      {platform.fields.map((field) => (
        <div key={field.key} className="space-y-1">
          <Label className="text-[11px] font-medium">{field.label}</Label>
          <Input
            placeholder={field.placeholder}
            value={field.key === 'page_id' ? form.page_id : form.phone_number_id}
            onChange={(e) => set(field.key === 'page_id' ? 'page_id' : 'phone_number_id', e.target.value)}
            className="h-8 text-sm"
            data-testid={`input-new-${field.key}`}
          />
        </div>
      ))}

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        <Button
          size="sm"
          className="h-8"
          onClick={handleAdd}
          disabled={!form.access_token.trim() || addMutation.isPending}
          data-testid="button-add-account"
        >
          {addMutation.isPending
            ? <Loader2 size={13} className="animate-spin mr-1" />
            : <Check size={13} className="mr-1" />}
          Add Account
        </Button>
        <Button variant="ghost" size="sm" className="h-8" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
};

// ─── Main component ────────────────────────────────────────────────────────────
export const PlatformSettings = () => {
  const { data: connections = [] } = usePlatformConnections();

  const [activePlatform, setActivePlatform] = useState<Platform>(() =>
    (localStorage.getItem('platform-tab') as Platform) || 'facebook'
  );
  const [showNewForm, setShowNewForm] = useState<Record<Platform, boolean>>({
    facebook: false,
    whatsapp: false,
    instagram: false,
  });

  const handleTabSwitch = (p: Platform) => {
    setActivePlatform(p);
    localStorage.setItem('platform-tab', p);
  };

  const platformAccounts = (p: Platform) =>
    connections.filter((c) => c.platform === p);

  const currentPlatform = PLATFORMS.find((p) => p.id === activePlatform)!;
  const currentAccounts = platformAccounts(activePlatform);

  return (
    <div className="space-y-4">
      {/* Platform tabs */}
      <div className="flex gap-2 flex-wrap">
        {PLATFORMS.map((p) => {
          const count = platformAccounts(p.id).filter((c) => c.is_active).length;
          const isActive = activePlatform === p.id;
          return (
            <button
              key={p.id}
              onClick={() => handleTabSwitch(p.id)}
              data-testid={`tab-${p.id}`}
              className={cn(
                "flex items-center gap-2 px-3.5 py-2.5 rounded-xl border transition-all text-sm font-medium",
                isActive
                  ? "border-primary bg-primary/5 text-foreground shadow-sm"
                  : "border-border bg-muted/30 text-muted-foreground hover:bg-muted/50"
              )}
            >
              <p.icon size={16} className={isActive ? p.color : ''} />
              {p.label}
              {count > 0 && (
                <span className={cn(
                  "text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center",
                  isActive ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                )}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Platform info */}
      <div className={cn("flex items-start gap-2 px-3.5 py-2.5 rounded-xl border text-xs", currentPlatform.bgColor, currentPlatform.borderColor)}>
        <Shield size={13} className={cn("mt-0.5 flex-shrink-0", currentPlatform.color)} />
        <div>
          <p className="font-semibold text-foreground">{currentPlatform.label} Business</p>
          <p className="text-muted-foreground mt-0.5">{currentPlatform.hint}</p>
        </div>
      </div>

      {/* Accounts list */}
      <div className="space-y-2">
        {currentAccounts.length === 0 && !showNewForm[activePlatform] && (
          <div className="text-center py-8 text-muted-foreground">
            <div className="w-12 h-12 rounded-full bg-muted/50 flex items-center justify-center mx-auto mb-3">
              <currentPlatform.icon size={20} className="text-muted-foreground/40" />
            </div>
            <p className="text-sm font-medium">No {currentPlatform.label} accounts yet</p>
            <p className="text-xs mt-1 text-muted-foreground/60">Click "Add Account" to connect your first account</p>
          </div>
        )}

        {currentAccounts.map((account) => (
          <AccountCard
            key={account.id}
            account={account}
            platform={currentPlatform}
          />
        ))}

        {/* New account form */}
        {showNewForm[activePlatform] && (
          <NewAccountForm
            platform={currentPlatform}
            onSaved={() => setShowNewForm((prev) => ({ ...prev, [activePlatform]: false }))}
            onCancel={() => setShowNewForm((prev) => ({ ...prev, [activePlatform]: false }))}
          />
        )}

        {/* Add New button */}
        {!showNewForm[activePlatform] && (
          <Button
            variant="outline"
            className="w-full border-dashed h-9 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/40"
            onClick={() => setShowNewForm((prev) => ({ ...prev, [activePlatform]: true }))}
            data-testid={`button-add-new-${activePlatform}`}
          >
            <Plus size={15} className="mr-1.5" />
            Add {currentPlatform.label} Account
          </Button>
        )}
      </div>

      {/* Summary */}
      {connections.length > 0 && (
        <div className="rounded-xl bg-muted/30 border border-border p-3 space-y-1.5">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Connected Accounts</p>
          <div className="flex flex-wrap gap-1.5">
            {PLATFORMS.map((p) => {
              const active = platformAccounts(p.id).filter((c) => c.is_active);
              if (active.length === 0) return null;
              return (
                <div key={p.id} className={cn("flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-lg border", p.bgColor, p.borderColor)}>
                  <p.icon size={12} className={p.color} />
                  <span className={cn("font-semibold", p.color)}>{active.length}</span>
                  <span className="text-muted-foreground">{p.label}</span>
                </div>
              );
            })}
          </div>
          <div className="space-y-1 pt-1">
            {connections.filter((c) => c.is_active).map((c) => {
              const plat = PLATFORMS.find((p) => p.id === c.platform);
              return (
                <div key={c.id} className="flex items-center gap-2 text-[11px]">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
                  {plat && <plat.icon size={11} className={plat.color} />}
                  <span className="font-medium text-foreground truncate">
                    {c.label || `${plat?.label} Account`}
                  </span>
                  {(c.page_id || c.phone_number_id) && (
                    <span className="text-muted-foreground/60 font-mono truncate">
                      · {c.page_id || c.phone_number_id}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
