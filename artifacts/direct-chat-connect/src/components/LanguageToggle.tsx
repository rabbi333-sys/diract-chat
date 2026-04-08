import { useLanguage } from '@/contexts/LanguageContext';
import { cn } from '@/lib/utils';

export const LanguageToggle = () => {
  const { lang, setLang } = useLanguage();

  return (
    <div className="flex items-center gap-0.5 bg-muted rounded-lg p-0.5" data-testid="language-toggle">
      <button
        onClick={() => setLang('en')}
        data-testid="lang-en"
        className={cn(
          'px-2.5 py-1 rounded-md text-xs font-semibold transition-all',
          lang === 'en'
            ? 'bg-background text-foreground shadow-sm'
            : 'text-muted-foreground hover:text-foreground'
        )}
      >
        EN
      </button>
      <button
        onClick={() => setLang('bn')}
        data-testid="lang-bn"
        className={cn(
          'px-2.5 py-1 rounded-md text-xs font-semibold transition-all',
          lang === 'bn'
            ? 'bg-background text-foreground shadow-sm'
            : 'text-muted-foreground hover:text-foreground'
        )}
      >
        বাংলা
      </button>
    </div>
  );
};
