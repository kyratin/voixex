"use client"

import { cn } from "@/lib/utils"
import { LANGUAGES, type Locale } from "@/lib/i18n/types"
import { useI18n } from "@/lib/i18n/provider"

type LanguageSelectorProps = {
  className?: string
}

export function LanguageSelector({ className }: LanguageSelectorProps) {
  const { locale, setLocale, t } = useI18n()

  return (
    <div className={cn("space-y-3", className)}>
      <p className="text-sm text-muted-foreground">{t("language.description")}</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {LANGUAGES.map((lang) => {
          const active = locale === lang.locale
          return (
            <button
              key={lang.locale}
              type="button"
              onClick={() => setLocale(lang.locale)}
              className={cn(
                "flex flex-col items-center gap-2 rounded-xl border px-3 py-4 text-center transition-colors",
                active
                  ? "border-primary bg-primary/10 ring-1 ring-primary/40"
                  : "border-border bg-card hover:border-primary/40 hover:bg-muted/40"
              )}
              aria-pressed={active}
              aria-label={lang.nativeName}
            >
              <span className="text-3xl leading-none" role="img" aria-hidden>
                {lang.flag}
              </span>
              <span className={cn("text-xs font-medium", active ? "text-primary" : "text-foreground")}>
                {lang.nativeName}
              </span>
            </button>
          )
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        {t("language.current")}: {LANGUAGES.find((l) => l.locale === locale)?.flag}{" "}
        {LANGUAGES.find((l) => l.locale === locale)?.nativeName}
      </p>
    </div>
  )
}

export function languageFlag(locale: Locale): string {
  return LANGUAGES.find((l) => l.locale === locale)?.flag ?? "🌐"
}
