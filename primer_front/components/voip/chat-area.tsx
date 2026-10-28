"use client"

import { cn } from "@/lib/utils"
import { Hash, Menu, Paperclip, Send, Users } from "lucide-react"
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { useI18n } from "@/lib/i18n/provider"
import { avatarGradient } from "@/lib/avatar-colors"

export interface Message {
  id: string
  author: {
    id: string
    name: string
    avatar: string
    isBot?: boolean
  }
  content: string
  timestamp: Date
  isEdited?: boolean
  reactions?: { emoji: string; count: number; reacted: boolean }[]
  attachments?: Array<{
    id: string
    name: string
    mime: string
    sizeBytes: number
    url: string
  }>
}

interface ChatAreaProps {
  channelName: string
  /** Header picture set by admins for this channel. */
  bannerUrl?: string | null
  channelType: "text" | "voice"
  messages: Message[]
  onSendMessage: (content: string) => void
  onUploadAttachment?: (file: File) => Promise<void>
  showMemberList: boolean
  onToggleMemberList: () => void
  canSend?: boolean
  /** Shown between the header and the messages, e.g. the voice stage while in voice. */
  stage?: ReactNode
  /** Narrow screens: opens the channel list drawer. */
  onOpenNavigation?: () => void
}

/** Messages of one author closer than this are shown as one group. */
const GROUP_WINDOW_MS = 5 * 60_000

function HeaderButton({ label, active, onClick, children }: { label: string; active?: boolean; onClick?: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          className={cn(
            "flex size-8 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export function ChatArea({
  channelName,
  bannerUrl = null,
  messages,
  onSendMessage,
  onUploadAttachment,
  showMemberList,
  onToggleMemberList,
  canSend = true,
  stage,
  onOpenNavigation
}: ChatAreaProps) {
  const { t, dict } = useI18n()
  const [messageInput, setMessageInput] = useState("")
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  // Grow the composer with its content, up to max-h.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${el.scrollHeight}px`
  }, [messageInput])

  const handleSend = () => {
    if (messageInput.trim() && canSend) {
      onSendMessage(messageInput)
      setMessageInput("")
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSend()
    }
  }

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const handleSelectAttachment = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file || !onUploadAttachment) return
    try {
      setUploading(true)
      await onUploadAttachment(file)
    } finally {
      setUploading(false)
      event.target.value = ""
    }
  }

  const formatTime = (date: Date) =>
    `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`

  const formatFullDate = (date: Date) => {
    const months = dict.time.months
    return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()} ${formatTime(date)}`
  }

  const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`

  const dayLabel = (date: Date) => {
    const today = new Date()
    const yesterday = new Date()
    yesterday.setDate(today.getDate() - 1)
    if (dayKey(date) === dayKey(today)) return t("chat.today")
    if (dayKey(date) === dayKey(yesterday)) return t("chat.yesterday")
    const months = dict.time.months
    return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`
  }

  const placeholder = canSend ? t("chat.messagePlaceholder", { channel: channelName }) : t("chat.messagingDisabled")

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background">
      <header className={cn("relative isolate flex shrink-0 items-center gap-3 overflow-hidden bg-card px-3 sm:px-5", bannerUrl ? "h-24 items-end pb-3" : "h-14")}>
        {bannerUrl ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={bannerUrl} alt="" className="pointer-events-none absolute inset-0 -z-10 h-full w-full object-cover opacity-60" />
            <div className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-t from-card via-card/60 to-transparent" />
          </>
        ) : null}
        {onOpenNavigation ? (
          <button
            type="button"
            onClick={onOpenNavigation}
            aria-label={t("sidebar.openChannels")}
            className="relative -ml-1 rounded-md p-2 text-muted-foreground hover:bg-secondary hover:text-foreground md:hidden"
          >
            <Menu className="h-5 w-5" />
          </button>
        ) : null}
        <Hash className="relative h-5 w-5 shrink-0 text-muted-foreground" />
        <h1 className="relative truncate text-sm font-bold text-foreground">{channelName}</h1>
        <div className="relative ml-auto flex items-center gap-1">
          <HeaderButton label={t("chat.toggleMembers")} active={showMemberList} onClick={onToggleMemberList}>
            <Users className="h-4 w-4" />
          </HeaderButton>
        </div>
      </header>

      {stage}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-5 sm:py-5">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="flex size-14 items-center justify-center rounded-full bg-secondary">
              <Hash className="h-7 w-7 text-foreground" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-foreground">{t("chat.welcomeTitle", { channel: channelName })}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{t("chat.welcomeEmpty")}</p>
            </div>
          </div>
        ) : (
          messages.map((message, index) => {
            const prev = messages[index - 1]
            const newDay = !prev || dayKey(prev.timestamp) !== dayKey(message.timestamp)
            const grouped =
              !newDay &&
              prev.author.id === message.author.id &&
              message.timestamp.getTime() - prev.timestamp.getTime() < GROUP_WINDOW_MS
            return (
              <Fragment key={message.id}>
                {newDay ? (
                  <div className="my-5 flex items-center gap-3 first:mt-0">
                    <span className="h-px flex-1 bg-border" />
                    <span className="text-[11px] font-medium text-muted-foreground">{dayLabel(message.timestamp)}</span>
                    <span className="h-px flex-1 bg-border" />
                  </div>
                ) : null}
                <article className={cn("group flex gap-3 rounded-lg px-2 py-0.5 hover:bg-card/60", grouped ? "mt-0" : "mt-4 first:mt-0")}>
                  {grouped ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="w-9 shrink-0 pt-1 text-right text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100">
                          {formatTime(message.timestamp)}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="left">{formatFullDate(message.timestamp)}</TooltipContent>
                    </Tooltip>
                  ) : (
                    <div
                      className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white"
                      style={{ background: avatarGradient(message.author.id || message.author.name) }}
                    >
                      {message.author.avatar}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    {!grouped ? (
                      <div className="flex items-baseline gap-2">
                        <span className="text-sm font-semibold text-foreground">{message.author.name}</span>
                        {message.author.isBot ? <Badge className="h-4 px-1 text-[9px]">BOT</Badge> : null}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="cursor-default text-[10px] text-muted-foreground">
                              {dayLabel(message.timestamp)} · {formatTime(message.timestamp)}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="top">{formatFullDate(message.timestamp)}</TooltipContent>
                        </Tooltip>
                      </div>
                    ) : null}
                    {message.content ? (
                      <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground/90">
                        {message.content}
                        {message.isEdited ? <span className="ml-1 text-[10px] text-muted-foreground">{t("common.edited")}</span> : null}
                      </p>
                    ) : null}
                    {message.attachments && message.attachments.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {message.attachments.map((attachment) =>
                          attachment.mime.startsWith("image/") ? (
                            <a key={attachment.id} href={attachment.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg bg-card">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={attachment.url} alt={attachment.name} className="max-h-64 max-w-sm object-contain" />
                            </a>
                          ) : attachment.mime.startsWith("video/") ? (
                            <video key={attachment.id} controls className="max-h-64 max-w-md rounded-lg bg-black" src={attachment.url} />
                          ) : attachment.mime.startsWith("audio/") ? (
                            <audio key={attachment.id} controls className="w-80 max-w-full" src={attachment.url} />
                          ) : (
                            <a
                              key={attachment.id}
                              href={attachment.url}
                              target="_blank"
                              rel="noreferrer"
                              className="flex max-w-xs items-center gap-2 rounded-lg bg-card px-3 py-2 text-sm text-foreground hover:bg-sidebar-accent"
                            >
                              <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" />
                              <span className="min-w-0 truncate">{attachment.name}</span>
                              <span className="shrink-0 text-xs text-muted-foreground">{formatFileSize(attachment.sizeBytes)}</span>
                            </a>
                          )
                        )}
                      </div>
                    ) : null}
                    {message.reactions && message.reactions.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {message.reactions.map((reaction, i) => (
                          <span
                            key={i}
                            className={cn(
                              "rounded-md px-2 py-0.5 text-[11px]",
                              reaction.reacted ? "bg-primary/20 text-foreground" : "bg-secondary text-muted-foreground"
                            )}
                          >
                            {reaction.emoji} {reaction.count}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </article>
              </Fragment>
            )
          })
        )}
      </div>

      <div className="shrink-0 px-5 pb-4">
        <div className="flex items-end gap-2 rounded-xl bg-input p-2">
          <input ref={fileInputRef} type="file" className="hidden" onChange={handleSelectAttachment} disabled={!canSend || uploading} />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={uploading ? t("chat.uploading") : t("chat.attachFile")}
                onClick={() => fileInputRef.current?.click()}
                disabled={!canSend || uploading || !onUploadAttachment}
                className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground disabled:opacity-40"
              >
                {uploading ? <Spinner className="h-4 w-4" /> : <Paperclip className="h-4 w-4" />}
              </button>
            </TooltipTrigger>
            <TooltipContent>{uploading ? t("chat.uploading") : t("chat.attachFile")}</TooltipContent>
          </Tooltip>
          <textarea
            ref={textareaRef}
            value={messageInput}
            onChange={(e) => setMessageInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={!canSend}
            rows={1}
            className="max-h-28 min-h-8 flex-1 resize-none bg-transparent px-1 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t("chat.sendMessage")}
                onClick={handleSend}
                disabled={!messageInput.trim() || !canSend}
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors",
                  messageInput.trim() && canSend ? "bg-primary text-primary-foreground hover:bg-primary/90" : "text-muted-foreground opacity-40"
                )}
              >
                <Send className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{t("chat.sendMessage")}</TooltipContent>
          </Tooltip>
        </div>
        {canSend ? <p className="mt-2 px-2 text-[10px] text-muted-foreground">{t("chat.inputHint")}</p> : null}
      </div>
    </div>
  )
}
