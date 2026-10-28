"use client"

import { avatarGradient } from "@/lib/avatar-colors"
import { cn } from "@/lib/utils"

/** The server's icon from its admins, or its first letter on a gradient. */
export function ServerIcon({ name, iconUrl, seed, className }: { name: string; iconUrl: string | null; seed: string; className?: string }) {
  if (iconUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={iconUrl} alt="" className={cn("shrink-0 rounded-xl object-cover", className)} />
    )
  }
  return (
    <div
      className={cn("flex shrink-0 items-center justify-center rounded-xl font-bold text-white", className)}
      style={{ background: avatarGradient(seed || name) }}
    >
      {name.slice(0, 1).toUpperCase() || "S"}
    </div>
  )
}

const ICON_SIZE = 128

/**
 * A picked image as a small square icon (center-cropped, 128 px) in a data: URL, so the server
 * stores it itself and every member sees it without extra hosting.
 */
export async function imageFileToIcon(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const side = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement("canvas")
  canvas.width = ICON_SIZE
  canvas.height = ICON_SIZE
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("no canvas")
  ctx.imageSmoothingQuality = "high"
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, ICON_SIZE, ICON_SIZE)
  bitmap.close()
  const webp = canvas.toDataURL("image/webp", 0.9)
  return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/png")
}
