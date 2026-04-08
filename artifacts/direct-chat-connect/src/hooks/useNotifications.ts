import { useEffect, useRef, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

// Base64 encoded short notification beep sound
const BEEP_SOUND = 'data:audio/wav;base64,UklGRl9vT19teleSkZXh0AABkYXRh';

export interface NotificationCounts {
  handoff: number;
  failed: number;
  orders: number;
}

export const useNotifications = () => {
  const [enabled, setEnabled] = useState(() => {
    return localStorage.getItem('notifications_enabled') === 'true';
  });
  const [soundEnabled, setSoundEnabled] = useState(() => {
    return localStorage.getItem('notification_sound') !== 'false';
  });
  const [counts, setCounts] = useState<NotificationCounts>({ handoff: 0, failed: 0, orders: 0 });
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Create a reliable notification sound using AudioContext
  const playSound = useCallback(() => {
    if (!soundEnabled) return;
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      
      // Play two quick beeps
      const playBeep = (startTime: number, freq: number, duration: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = freq;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0.3, startTime);
        gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
        osc.start(startTime);
        osc.stop(startTime + duration);
      };
      
      const now = ctx.currentTime;
      playBeep(now, 880, 0.15);        // A5
      playBeep(now + 0.18, 1100, 0.15); // C#6
      playBeep(now + 0.36, 1320, 0.2);  // E6

      setTimeout(() => ctx.close(), 1000);
    } catch {
      // Fallback silent
    }
  }, [soundEnabled]);

  const toggleEnabled = async () => {
    if (!enabled) {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') {
          toast.error('Allow browser notifications to enable alerts');
          return;
        }
      }
      localStorage.setItem('notifications_enabled', 'true');
      setEnabled(true);
      toast.success('🔔 Notifications enabled');
    } else {
      localStorage.setItem('notifications_enabled', 'false');
      setEnabled(false);
      setCounts({ handoff: 0, failed: 0, orders: 0 });
      toast.info('🔕 Notifications disabled');
    }
  };

  const toggleSound = () => {
    const next = !soundEnabled;
    setSoundEnabled(next);
    localStorage.setItem('notification_sound', String(next));
    if (next) {
      toast.success('🔊 Notification sound on');
      // Play test sound
      setTimeout(() => playSound(), 200);
    } else {
      toast.info('🔇 Notification sound off');
    }
  };

  const clearCount = (type: keyof NotificationCounts) => {
    setCounts(prev => ({ ...prev, [type]: 0 }));
  };

  const showNotification = useCallback((title: string, body: string, tag?: string) => {
    if (!enabled) return;

    // In-app toast with custom styling
    toast(title, {
      description: body,
      duration: 8000,
      icon: tag?.startsWith('handoff') ? '🤝' : tag?.startsWith('failed') ? '❌' : '📦',
      style: {
        border: '1px solid hsl(var(--primary) / 0.3)',
        background: 'hsl(var(--background))',
      },
    });

    // Play sound
    playSound();

    // Browser notification
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        new Notification(title, {
          body,
          icon: '/favicon.ico',
          tag: tag || 'default',
          requireInteraction: true,
        });
      } catch {
        // Already showed toast
      }
    }
  }, [enabled, playSound]);

  // Listen for realtime events
  useEffect(() => {
    if (!enabled) return;

    const handoffChannel = supabase
      .channel('notif-handoff')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'handoff_requests' },
        (payload) => {
          const data = payload.new as any;
          setCounts(prev => ({ ...prev, handoff: prev.handoff + 1 }));
          showNotification(
            '🤝 Human Handoff Needed!',
            `${data.reason || 'Help required'}${data.recipient ? ` — ${data.recipient}` : ''}`,
            `handoff-${data.id}`
          );
        }
      )
      .subscribe();

    const failedChannel = supabase
      .channel('notif-failed')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'failed_automations' },
        (payload) => {
          const data = payload.new as any;
          setCounts(prev => ({ ...prev, failed: prev.failed + 1 }));
          showNotification(
            '❌ Automation Failed!',
            `${data.error_message || 'Unknown error'}${data.workflow_name ? ` (${data.workflow_name})` : ''}`,
            `failed-${data.id}`
          );
        }
      )
      .subscribe();

    const orderChannel = supabase
      .channel('notif-orders')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'orders' },
        (payload) => {
          const data = payload.new as any;
          setCounts(prev => ({ ...prev, orders: prev.orders + 1 }));
          showNotification(
            '📦 New Order Received!',
            `${data.product_name || 'Product'} × ${data.quantity || 1}${data.customer_name ? ` — ${data.customer_name}` : ''}`,
            `order-${data.id}`
          );
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(handoffChannel);
      supabase.removeChannel(failedChannel);
      supabase.removeChannel(orderChannel);
    };
  }, [enabled, showNotification]);

  return { enabled, soundEnabled, toggleEnabled, toggleSound, counts, clearCount, playSound };
};
