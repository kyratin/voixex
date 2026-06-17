"use client"

import { cn } from "@/lib/utils"
import { Hash, Users, Send, Paperclip, MessageSquare } from "lucide-react"
import { useState, useRef, useEffect } from "react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { useI18n } from "@/lib/i18n/provider"

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
  channelType: "text" | "voice"
  messages: Message[]
  onSendMessage: (content: string) => void
  onUploadAttachment?: (file: File) => Promise<void>
  showMemberList: boolean
  onToggleMemberList: () => void
  canSend?: boolean
}

export function ChatArea({ 
  channelName, 
  channelType, 
  messages, 
  onSendMessage,
  onUploadAttachment,
  showMemberList,
  onToggleMemberList,
  canSend = true
}: ChatAreaProps) {
  const { t, dict } = useI18n()
  const [messageInput, setMessageInput] = useState("")
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  const handleSend = () => {
    if (messageInput.trim() && canSend) {
      onSendMessage(messageInput)
      setMessageInput("")
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
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

  const formatTime = (date: Date) => {
    const hours = date.getHours().toString().padStart(2, "0")
    const minutes = date.getMinutes().toString().padStart(2, "0")
    return `${hours}:${minutes}`
  }

  const formatRelativeTime = (date: Date) => {
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMin = Math.floor(diffMs / 60000)
    if (diffMin < 1) return t("chat.justNow")
    if (diffMin < 60) return t("chat.minutesAgo", { n: diffMin })
    const diffHr = Math.floor(diffMin / 60)
    if (diffHr < 24) return t("chat.hoursAgo", { n: diffHr })
    const diffDay = Math.floor(diffHr / 24)
    if (diffDay < 7) return t("chat.daysAgo", { n: diffDay })
    return formatFullDate(date)
  }

  const formatFullDate = (date: Date) => {
    const months = dict.time.months
    return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()} ${formatTime(date)}`
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-2">
          <Hash className="h-5 w-5 text-muted-foreground" />
          <span className="text-sm font-semibold text-foreground">{channelName}</span>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={showMemberList ? "secondary" : "ghost"}
              size="icon-sm"
              onClick={onToggleMemberList}
            >
              <Users className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("chat.toggleMembers")}</TooltipContent>
        </Tooltip>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
              <MessageSquare className="h-8 w-8 text-muted-foreground" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-foreground">{t("chat.welcomeTitle", { channel: channelName })}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("chat.welcomeEmpty")}
              </p>
            </div>
          </div>
        ) : (
          <div className="p-4">
            <div className="mb-4 pb-4 border-b border-border">
              <h3 className="text-base font-semibold text-foreground">{t("chat.welcomeTitle", { channel: channelName })}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("chat.welcomeStart")}
              </p>
            </div>

            <div className="space-y-4">
              {messages.map((message) => (
                <div key={message.id} className="group flex gap-3 rounded-lg px-2 py-1 -mx-2 hover:bg-muted/30">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-muted-foreground">
                    {message.author.avatar}
                  </div>
                  
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-semibold text-foreground">
                        {message.author.name}
                      </span>
                      {message.author.isBot && (
                        <Badge variant="default" className="h-4 px-1 text-[9px]">BOT</Badge>
                      )}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="text-[11px] text-muted-foreground cursor-default">
                            {formatRelativeTime(message.timestamp)}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top">
                          {formatFullDate(message.timestamp)}
                        </TooltipContent>
                      </Tooltip>
                      {message.isEdited && (
                        <span className="text-[10px] text-muted-foreground">{t("common.edited")}</span>
                      )}
                    </div>
                    <p className="text-sm text-foreground/90 break-words leading-relaxed">{message.content}</p>
                    {message.attachments && message.attachments.length > 0 && (
                      <div className="mt-2 space-y-2">
                        {message.attachments.map((attachment) => (
                          <div key={attachment.id} className="max-w-md rounded-lg border border-border bg-card p-3">
                            <div className="mb-2 text-xs text-muted-foreground">
                              {attachment.name} ({formatFileSize(attachment.sizeBytes)})
                            </div>
                            {attachment.mime.startsWith("image/") ? (
                              <img src={attachment.url} alt={attachment.name} className="max-h-64 rounded-md" />
                            ) : attachment.mime.startsWith("video/") ? (
                              <video controls className="max-h-64 w-full rounded-md" src={attachment.url} />
                            ) : attachment.mime.startsWith("audio/") ? (
                              <audio controls className="w-full" src={attachment.url} />
                            ) : (
                              <a href={attachment.url} target="_blank" rel="noreferrer" className="text-sm text-primary hover:underline">
                                {t("common.downloadAttachment")}
                              </a>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    
                    {message.reactions && message.reactions.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {message.reactions.map((reaction, i) => (
                          <button
                            key={i}
                            className={cn(
                              "flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors hover:bg-muted",
                              reaction.reacted ? "border-primary/50 bg-primary/10" : "border-border"
                            )}
                          >
                            <span>{reaction.emoji}</span>
                            <span className="text-muted-foreground">{reaction.count}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border px-4 py-3">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-input px-3 py-1 focus-within:border-ring focus-within:ring-1 focus-within:ring-ring/50">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={handleSelectAttachment}
            disabled={!canSend || uploading}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={!canSend || uploading}
                className="shrink-0 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              >
                {uploading ? <Spinner className="h-5 w-5" /> : <Paperclip className="h-5 w-5" />}
              </button>
            </TooltipTrigger>
            <TooltipContent>{uploading ? t("chat.uploading") : t("chat.attachFile")}</TooltipContent>
          </Tooltip>
          <input
            type="text"
            value={messageInput}
            onChange={(e) => setMessageInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={canSend ? t("chat.messagePlaceholder", { channel: channelName }) : t("chat.messagingDisabled")}
            disabled={!canSend}
            className="flex-1 bg-transparent py-1.5 text-sm text-foreground placeholder:text-muted-foreground outline-none disabled:cursor-not-allowed"
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleSend}
                disabled={!messageInput.trim() || !canSend}
                className={cn(
                  "shrink-0 rounded-md p-1.5 transition-colors",
                  messageInput.trim() && canSend
                    ? "bg-primary text-primary-foreground hover:bg-primary/90"
                    : "text-muted-foreground opacity-50"
                )}
              >
                <Send className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{t("chat.sendMessage")}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}
