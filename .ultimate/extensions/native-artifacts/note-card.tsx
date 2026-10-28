import { useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ReferenceImages } from './attachments.tsx'
import type { TargetRect } from './types.ts'
import type { ReviewDraft } from './ui.tsx'

export function NoteCard({
  draft,
  update,
  rect,
  frame,
  focus,
  onClose,
}: {
  draft: ReviewDraft
  update: (change: (current: ReviewDraft) => ReviewDraft) => void
  rect: TargetRect | null
  frame: HTMLElement | null
  focus: number
  onClose: () => void
}) {
  const card = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const [position, setPosition] = useState({ left: 12, top: 80, width: 350, maxHeight: 600 })
  useLayoutEffect(() => {
    input.current?.focus()
  }, [draft.editorId, focus])
  useLayoutEffect(() => {
    const place = () => {
      const viewport = window.visualViewport
      const left = viewport?.offsetLeft ?? 0
      const top = viewport?.offsetTop ?? 0
      const width = viewport?.width ?? window.innerWidth
      const height = viewport?.height ?? window.innerHeight
      const box = frame?.querySelector('iframe')?.getBoundingClientRect()
      const targetX = (box?.left ?? 0) + (rect?.x ?? 16)
      const targetTop = (box?.top ?? 40) + (rect?.y ?? 0)
      const targetBottom = targetTop + (rect?.height ?? 0)
      const cardWidth = Math.min(350, width - 24)
      const maxHeight = Math.max(120, height - 24)
      const cardHeight = Math.min(card.current?.offsetHeight ?? 300, maxHeight)
      const below = targetBottom + 8
      const y = below + cardHeight <= top + height - 12 ? below : targetTop - cardHeight - 8
      const next = {
        left: Math.max(left + 12, Math.min(targetX, left + width - cardWidth - 12)),
        top: Math.max(top + 12, Math.min(y, top + height - cardHeight - 12)),
        width: cardWidth,
        maxHeight,
      }
      setPosition((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next))
    }
    place()
    const observer = new ResizeObserver(place)
    if (card.current) observer.observe(card.current)
    if (frame) observer.observe(frame)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    window.visualViewport?.addEventListener('resize', place)
    window.visualViewport?.addEventListener('scroll', place)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      window.visualViewport?.removeEventListener('resize', place)
      window.visualViewport?.removeEventListener('scroll', place)
    }
  }, [rect, frame])
  return (
    <div
      ref={card}
      role="dialog"
      aria-label="Annotation note"
      data-artifact-note
      className="fixed z-40 space-y-3 overflow-y-auto rounded-lg border border-brand/60 bg-background p-3 shadow-xl"
      style={position}
    >
      <h2 className="text-[13px] font-medium">
        {draft.anchor?.kind === 'text' ? 'Annotate selection' : 'Annotate element'}
      </h2>
      <blockquote className="line-clamp-2 border-l border-border pl-2 text-[11px] text-muted-foreground">
        {draft.anchor?.text || draft.anchor?.selector}
      </blockquote>
      {!rect && (
        <p className="text-[11px] text-warning">
          Target is no longer visible. This note keeps its original reference.
        </p>
      )}
      <textarea
        ref={input}
        aria-label="Note for selection"
        className="min-h-24 w-full resize-y rounded-md border border-border/70 bg-background p-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-brand/40 sm:text-[13px]"
        rows={3}
        maxLength={4000}
        placeholder="What should change about this element?"
        value={draft.editor}
        onChange={(event) => update((current) => ({ ...current, editor: event.target.value }))}
      />
      <ReferenceImages draft={draft} update={update} noteId={draft.editorId} label="Attach image" />
      {draft.notes.length >= 50 && (
        <p className="text-[11px] text-warning">
          Queue up to 50 notes per batch. Send or remove a queued note first.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={!!draft.readingImages}
          onClick={() => {
            update((current) => ({
              ...current,
              images: current.images.filter((image) => image.noteId !== current.editorId),
              editor: '',
              editorId: undefined,
              anchor: undefined,
            }))
            onClose()
          }}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={
            (!draft.editor.trim() &&
              !draft.images.some((image) => image.noteId === draft.editorId)) ||
            !!draft.readingImages ||
            draft.notes.length >= 50
          }
          onClick={() => {
            update((current) => ({
              ...current,
              notes: [
                ...current.notes,
                { id: current.editorId!, text: current.editor.trim(), anchor: current.anchor },
              ],
              editor: '',
              editorId: undefined,
              anchor: undefined,
            }))
            onClose()
          }}
        >
          Queue
        </Button>
      </div>
    </div>
  )
}
