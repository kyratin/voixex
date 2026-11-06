export type SendWork = { bytes: number; createdAt?: number; send: () => boolean; onDrop?: () => void }
type Item = SendWork & { at: number }
type Video = { at: number; items: SendWork[]; index: number; bytes: number }
/** Bounded application queues. Never replay old speech or let video outrank audio/control. */
export class MediaSendQueue {
  private audio: Item[] = []
  private control: Item[] = []
  private video = new Map<string, Video>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  readonly stats = { expiredAudio: 0, droppedVideo: 0, droppedAudio: 0 }
  constructor(private readonly clock = () => Date.now()) {}
  push(work: SendWork, control = false) {
    if(this.closed)return
    const item={...work,at:work.createdAt??this.clock()}
    if(this.clock()-item.at>(control?250:80)){work.onDrop?.();if(!control)this.stats.expiredAudio++;return}
    // Audio/control can immediately jump ahead of pending camera fragments.
    if((this.control.length+(control?0:this.audio.length))===0 && work.send())return
    const queue=control?this.control:this.audio
    while(queue.length>=(control?8:3)){queue.shift()?.onDrop?.();if(!control)this.stats.droppedAudio++}
    queue.push(item);this.schedule()
  }
  pushVideo(sender: string, items: SendWork[]) {
    if(this.closed||!items.length)return
    if(this.video.delete(sender))this.stats.droppedVideo++
    const bytes=items.reduce((n,item)=>n+item.bytes,0)
    if(bytes>128*1024){this.stats.droppedVideo++;return}
    while(this.video.size>=16||[...this.video.values()].reduce((n,v)=>n+v.bytes,0)+bytes>256*1024){
      const oldest=this.video.keys().next().value
      if(oldest===undefined)break
      this.video.delete(oldest);this.stats.droppedVideo++
    }
    this.video.set(sender,{at:this.clock(),items,index:0,bytes});this.schedule()
  }
  drain() {
    if(this.closed)return
    const now=this.clock()
    for(const [queue,ttl] of [[this.control,250],[this.audio,80]] as const){
      while(queue.length){
        const item=queue[0]
        if(now-item.at>ttl){queue.shift();item.onDrop?.();if(queue===this.audio)this.stats.expiredAudio++;continue}
        if(!item.send()){this.schedule();return}
        queue.shift()
      }
    }
    let budget=8
    for(const [sender,frame] of this.video){
      if(now-frame.at>100){this.video.delete(sender);this.stats.droppedVideo++;continue}
      while(frame.index<frame.items.length&&budget>0){
        if(!frame.items[frame.index].send()){this.schedule();return}
        frame.index++;budget--
      }
      if(frame.index===frame.items.length)this.video.delete(sender)
      if(budget===0)break
    }
    if(this.control.length||this.audio.length||this.video.size)this.schedule()
  }
  close() {
    this.closed=true
    if(this.timer)clearTimeout(this.timer)
    this.timer=null;this.audio=[];this.control=[];this.video.clear()
  }
  private schedule(){
    if(this.closed||this.timer)return
    this.timer=setTimeout(()=>{this.timer=null;this.drain()},1)
    ;(this.timer as unknown as {unref?:()=>void}).unref?.()
  }
}
