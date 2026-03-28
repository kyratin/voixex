"use client"

import { cn } from "@/lib/utils"
import { Hash, Users, Send, Paperclip } from "lucide-react"
import { useState, useRef, useEffect } from "react"

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

  const formatDate = (date: Date) => {
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)
    const msgDate = new Date(date.getFullYear(), date.getMonth(), date.getDate())

    if (msgDate.getTime() === today.getTime()) {
      return `Today ${formatTime(date)}`
    } else if (msgDate.getTime() === yesterday.getTime()) {
      return `Yesterday ${formatTime(date)}`
    } else {
      const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
      return `${months[date.getMonth()]} ${date.getDate()} ${formatTime(date)}`
    }
  }

  return (
    <div className="flex h-full flex-1 flex-col bg-background">
      {/* Channel Header */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-card px-3">
        <div className="flex items-center gap-2">
          <Hash className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">{channelName}</span>
        </div>
        <button 
          onClick={onToggleMemberList}
          className={cn(
            "rounded-sm border border-border p-1 text-muted-foreground hover:bg-muted hover:text-foreground",
            showMemberList && "bg-muted text-foreground"
          )}
          title="Toggle member list"
        >
          <Users className="h-4 w-4" />
        </button>
      </div>

      {/* Messages Area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto border-b border-border">
        <div className="p-3">
          {/* Welcome Message */}
          <div className="mb-4 border-b border-border pb-3">
            <div className="text-sm font-semibold text-foreground">
              Welcome to #{channelName}
            </div>
            <p className="text-xs text-muted-foreground">
              This is the beginning of the channel.
            </p>
          </div>

          {/* Messages */}
          <div className="space-y-2">
            {messages.map((message) => (
              <div key={message.id} className="flex gap-2">
                {/* Avatar */}
                <div className="h-8 w-8 shrink-0 rounded border border-border bg-muted flex items-center justify-center text-xs font-medium text-muted-foreground">
                  {message.author.avatar}
                </div>
                
                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-semibold text-foreground">
                      {message.author.name}
                    </span>
                    {message.author.isBot && (
                      <span className="rounded border border-primary bg-primary/10 px-1 text-[10px] font-medium text-primary">
                        BOT
                      </span>
                    )}
                    <span className="text-[10px] text-muted-foreground">
                      {formatDate(message.timestamp)}
                    </span>
                  </div>
                  <p className="text-sm text-foreground break-words">{message.content}</p>
                  {message.attachments && message.attachments.length > 0 && (
                    <div className="mt-2 space-y-2">
                      {message.attachments.map((attachment) => (
                        <div key={attachment.id} className="rounded border border-border bg-card p-2">
                          <div className="mb-1 text-xs text-muted-foreground">
                            {attachment.name} ({formatFileSize(attachment.sizeBytes)})
                          </div>
                          {attachment.mime.startsWith("image/") ? (
                            <img src={attachment.url} alt={attachment.name} className="max-h-56 rounded border border-border" />
                          ) : attachment.mime.startsWith("video/") ? (
                            <video controls className="max-h-56 w-full rounded border border-border" src={attachment.url} />
                          ) : attachment.mime.startsWith("audio/") ? (
                            <audio controls className="w-full" src={attachment.url} />
                          ) : (
                            <a href={attachment.url} target="_blank" rel="noreferrer" className="text-xs text-primary underline">
                              Download attachment
                            </a>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  
                  {/* Reactions */}
                  {message.reactions && message.reactions.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {message.reactions.map((reaction, i) => (
                        <button
                          key={i}
                          className={cn(
                            "flex items-center gap-1 rounded border border-border bg-muted px-1.5 py-0.5 text-xs hover:bg-secondary",
                            reaction.reacted && "border-primary bg-primary/10"
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
      </div>

      {/* Message Input */}
      <div className="shrink-0 bg-card p-3">
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={handleSelectAttachment}
            disabled={!canSend || uploading}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={!canSend || uploading}
            className="rounded border border-border px-2 py-2 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            title="Attach file"
          >
            <Paperclip className="h-4 w-4" />
          </button>
          <input
            type="text"
            value={messageInput}
            onChange={(e) => setMessageInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={canSend ? `Message #${channelName}` : "Messaging disabled for this channel"}
            disabled={!canSend}
            className="flex-1 rounded border border-border bg-input px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
          />
          <button
            onClick={handleSend}
            disabled={!messageInput.trim() || !canSend}
            className="rounded border border-border bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
