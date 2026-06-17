"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { en } from "./locales/en"
import { ru } from "./locales/ru"
import { es } from "./locales/es"
import { pt } from "./locales/pt"
import {
  LOCALE_STORAGE_KEY,
  detectBrowserLocale,
  isLocale,
  type Locale,
  type TranslationDict
} from "./types"

const dictionaries: Record<Locale, TranslationDict> = { en, ru, es, pt }

type TranslateParams = Record<string, string | number>

type I18nContextValue = {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: (key: string, params?: TranslateParams) => string
  dict: TranslationDict
}

const I18nContext = createContext<I18nContextValue | null>(null)

function resolveKey(dict: TranslationDict, key: string): string | readonly string[] | undefined {
  const parts = key.split(".")
  let cur: unknown = dict
  for (const part of parts) {
    if (cur === null || typeof cur !== "object" || !(part in (cur as object))) return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur as string | readonly string[] | undefined
}

function formatTemplate(template: string, params?: TranslateParams) {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`))
}

function readStoredLocale(): Locale {
  if (typeof window === "undefined") return "en"
  try {
    const raw = localStorage.getItem(LOCALE_STORAGE_KEY)
    if (raw && isLocale(raw)) return raw
  } catch {
    /* ignore */
  }
  return detectBrowserLocale()
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("en")

  useEffect(() => {
    setLocaleState(readStoredLocale())
  }, [])

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale
    }
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, locale)
    } catch {
      /* ignore */
    }
  }, [locale])

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next)
  }, [])

  const dict = dictionaries[locale]

  const t = useCallback(
    (key: string, params?: TranslateParams) => {
      const value = resolveKey(dict, key)
      if (typeof value === "string") return formatTemplate(value, params)
      return key
    },
    [dict]
  )

  const value = useMemo(() => ({ locale, setLocale, t, dict }), [locale, setLocale, t, dict])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n() {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error("useI18n must be used within I18nProvider")
  return ctx
}

export { dictionaries, en }
