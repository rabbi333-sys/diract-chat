import { createContext, useContext, useState, useEffect } from 'react';

export type Lang = 'en' | 'bn';

const translations = {
  en: {
    // Nav
    overview: 'Overview',
    messages: 'Messages',
    handoff: 'Handoff',
    failed: 'Failed',
    orders: 'Orders',
    n8nPrompt: 'n8n Prompt',
    teamMembers: 'Team Members',
    settings: 'Settings',
    profile: 'Profile',
    accountSettings: 'Account settings',
    theme: 'Theme',
    // Page headers
    overviewTitle: 'Overview',
    messagesTitle: 'Messages',
    handoffTitle: 'Human Handoff',
    failedTitle: 'Failed Automations',
    ordersTitle: '📦 Orders',
    n8nPromptTitle: 'n8n Agent Prompt',
    n8nPromptSub: 'Edit your n8n AI Agent system messages directly from here',
    settingsTitle: 'Settings',
    // Settings menu
    notifications: 'Notifications',
    notificationsSub: 'Browser push alerts & sound',
    platformConnections: 'Platform Connections',
    platformConnectionsSub: 'Facebook, WhatsApp, Instagram accounts',
    webhookApi: 'Webhook & API Endpoints',
    webhookApiSub: 'n8n integration endpoints & API key',
    database: 'Database',
    databaseSub: 'Connect to Supabase or PostgreSQL',
    aiControlSettings: 'n8n AI Control',
    aiControlSettingsSub: 'Setup AI ON/OFF toggle for n8n workflows',
    // Notifications settings
    browserNotifications: 'Browser Notifications',
    browserNotificationsSub: 'Get notified for Handoff, Failed Automations, and new Orders',
    soundAlerts: 'Sound Alerts',
    soundAlertsSub: 'Play a sound when a notification arrives',
    notifInfo: 'Receive browser notifications and sidebar badge counts for Handoff, Failed Automations, and new Orders.',
    // Settings back
    backToSettings: 'Settings',
    databaseSettingsSub: 'Connect your n8n database to view chats in the Messages tab.',
    // Platform/Webhook headers
    platformHeader: 'Platform Connections',
    webhookHeader: 'Webhook & API Endpoints',
    databaseHeader: 'Database',
    // Access denied
    accessNotGranted: 'Access not granted',
    accessNotGrantedSub: "Your account hasn't been invited to this dashboard. Contact the admin to receive an invite link.",
    signOut: 'Sign out',
    // No sections
    noSections: 'No sections available',
    noSectionsSub: 'Your account has no page permissions assigned. Ask the admin to update your invite.',
    // No access fallback
    noAccess: "You don't have access to this section.",
    // On/Off
    on: 'On',
    off: 'Off',
    // Search
    searchConversations: 'Search conversations...',
    // Messages tabs
    all: 'All',
    active: 'Active',
    // App name
    appName: 'Chat Monitor',
    // Language toggle
    language: 'Language',
  },
  bn: {
    // Nav
    overview: 'ওভারভিউ',
    messages: 'বার্তা',
    handoff: 'হ্যান্ডঅফ',
    failed: 'ব্যর্থ',
    orders: 'অর্ডার',
    n8nPrompt: 'n8n প্রম্পট',
    teamMembers: 'টিম মেম্বার',
    settings: 'সেটিংস',
    profile: 'প্রোফাইল',
    accountSettings: 'অ্যাকাউন্ট সেটিংস',
    theme: 'থিম',
    // Page headers
    overviewTitle: 'ওভারভিউ',
    messagesTitle: 'বার্তা',
    handoffTitle: 'মানব হস্তান্তর',
    failedTitle: 'ব্যর্থ অটোমেশন',
    ordersTitle: '📦 অর্ডার',
    n8nPromptTitle: 'n8n এজেন্ট প্রম্পট',
    n8nPromptSub: 'আপনার n8n AI এজেন্ট সিস্টেম মেসেজ এখান থেকে সম্পাদনা করুন',
    settingsTitle: 'সেটিংস',
    // Settings menu
    notifications: 'নোটিফিকেশন',
    notificationsSub: 'ব্রাউজার পুশ এলার্ট এবং সাউন্ড',
    platformConnections: 'প্ল্যাটফর্ম সংযোগ',
    platformConnectionsSub: 'Facebook, WhatsApp, Instagram অ্যাকাউন্ট',
    webhookApi: 'ওয়েবহুক ও API এন্ডপয়েন্ট',
    webhookApiSub: 'n8n ইন্টিগ্রেশন এন্ডপয়েন্ট ও API কী',
    database: 'ডেটাবেস',
    databaseSub: 'Supabase বা PostgreSQL সংযুক্ত করুন',
    aiControlSettings: 'n8n AI কন্ট্রোল',
    aiControlSettingsSub: 'n8n workflow-এ AI ON/OFF টগল সেটআপ করুন',
    // Notifications settings
    browserNotifications: 'ব্রাউজার নোটিফিকেশন',
    browserNotificationsSub: 'হ্যান্ডঅফ, ব্যর্থ অটোমেশন এবং নতুন অর্ডারের জন্য নোটিফিকেশন পান',
    soundAlerts: 'সাউন্ড এলার্ট',
    soundAlertsSub: 'নোটিফিকেশন আসলে সাউন্ড বাজবে',
    notifInfo: 'হ্যান্ডঅফ, ব্যর্থ অটোমেশন এবং নতুন অর্ডারের জন্য ব্রাউজার নোটিফিকেশন ও সাইডবার ব্যাজ পাবেন।',
    // Settings back
    backToSettings: 'সেটিংস',
    databaseSettingsSub: 'Messages ট্যাবে চ্যাট দেখতে আপনার n8n ডেটাবেস সংযুক্ত করুন।',
    // Platform/Webhook headers
    platformHeader: 'প্ল্যাটফর্ম সংযোগ',
    webhookHeader: 'ওয়েবহুক ও API এন্ডপয়েন্ট',
    databaseHeader: 'ডেটাবেস',
    // Access denied
    accessNotGranted: 'অ্যাক্সেস দেওয়া হয়নি',
    accessNotGrantedSub: 'আপনার অ্যাকাউন্ট এই ড্যাশবোর্ডে আমন্ত্রিত নয়। অ্যাডমিনকে একটি ইনভাইট লিংক পাঠাতে বলুন।',
    signOut: 'সাইন আউট',
    // No sections
    noSections: 'কোনো সেকশন উপলব্ধ নেই',
    noSectionsSub: 'আপনার অ্যাকাউন্টে কোনো পেজ অনুমতি নেই। অ্যাডমিনকে আপনার ইনভাইট আপডেট করতে বলুন।',
    // No access fallback
    noAccess: 'আপনার এই সেকশনে প্রবেশাধিকার নেই।',
    // On/Off
    on: 'চালু',
    off: 'বন্ধ',
    // Search
    searchConversations: 'কথোপকথন খুঁজুন...',
    // Messages tabs
    all: 'সব',
    active: 'সক্রিয়',
    // App name
    appName: 'চ্যাট মনিটর',
    // Language toggle
    language: 'ভাষা',
  },
} as const;

type TranslationKeys = keyof typeof translations.en;

interface LanguageContextValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: TranslationKeys) => string;
}

const LanguageContext = createContext<LanguageContextValue>({
  lang: 'en',
  setLang: () => {},
  t: (key) => translations.en[key],
});

const STORAGE_KEY = 'meta_dashboard_lang';

export const LanguageProvider = ({ children }: { children: React.ReactNode }) => {
  const [lang, setLangState] = useState<Lang>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'bn' || saved === 'en') return saved;
    } catch { /* ignore */ }
    return 'en';
  });

  const setLang = (l: Lang) => {
    setLangState(l);
    try { localStorage.setItem(STORAGE_KEY, l); } catch { /* ignore */ }
  };

  const t = (key: TranslationKeys): string => translations[lang][key];

  return (
    <LanguageContext.Provider value={{ lang, setLang, t }}>
      {children}
    </LanguageContext.Provider>
  );
};

export const useLanguage = () => useContext(LanguageContext);
