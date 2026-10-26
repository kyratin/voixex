import type { en } from "./locales/en"

export type Locale = "en" | "ru" | "es" | "pt"

/** Same keys as `en`, but any string values — `en` is `as const`, so its literal types would reject translations. */
type Widen<T> = T extends string
  ? string
  : T extends readonly (infer U)[]
    ? readonly Widen<U>[]
    : { readonly [K in keyof T]: Widen<T[K]> }

export type TranslationDict = Widen<typeof en>

export type LanguageOption = {
  locale: Locale
  /** Flag emoji for the language / region */
  flag: string
  nativeName: string
}

export const LANGUAGES: LanguageOption[] = [
  { locale: "en", flag: "🇺🇸", nativeName: "English" },
  { locale: "ru", flag: "🇷🇺", nativeName: "Русский" },
  { locale: "es", flag: "🇪🇸", nativeName: "Español" },
  { locale: "pt", flag: "🇵🇹", nativeName: "Português" }
]

export const LOCALE_STORAGE_KEY = "voixex-locale"

export function isLocale(value: string): value is Locale {
  return value === "en" || value === "ru" || value === "es" || value === "pt"
}

export function detectBrowserLocale(): Locale {
  if (typeof navigator === "undefined") return "en"
  const lang = navigator.language.toLowerCase()
  if (lang.startsWith("ru")) return "ru"
  if (lang.startsWith("es")) return "es"
  if (lang.startsWith("pt")) return "pt"
  return "en"
}
