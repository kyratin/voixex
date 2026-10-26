import type { Metadata } from 'next'
import { Toaster } from 'sonner'
import { Analytics } from '@vercel/analytics/next'
import { TooltipProvider } from '@/components/ui/tooltip'
import { I18nProvider } from '@/lib/i18n/provider'
import './fonts.css'
import './globals.css'

export const metadata: Metadata = {
  title: "Voixex",
  description: "Secure voice and text communication client",
  generator: "voixex",
  icons: {
    icon: [
      {
        url: "icon-light-32x32.png",
        media: "(prefers-color-scheme: light)",
      },
      {
        url: "icon-dark-32x32.png",
        media: "(prefers-color-scheme: dark)",
      },
      {
        url: "icon.svg",
        type: "image/svg+xml",
      },
    ],
    apple: "apple-icon.png",
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="dark h-full">
      <body className="h-full font-sans antialiased">
        <I18nProvider>
          <TooltipProvider delayDuration={300}>
            {children}
          </TooltipProvider>
          <Toaster
            theme="dark"
            position="bottom-right"
            toastOptions={{
              style: {
                background: 'var(--popover)',
                color: 'var(--popover-foreground)',
                border: '1px solid var(--border)',
              },
            }}
          />
          <Analytics />
        </I18nProvider>
      </body>
    </html>
  )
}
