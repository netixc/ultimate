import { useCallback, useEffect, useRef, useState } from 'react'
import type { ArtifactAnchor } from '../artifacts/types.ts'
import { decodeFrameMessage } from './bridge.ts'
import type { CaptureMode, NativeDocument, TargetStatus } from './types.ts'

export type ArtifactFrameProps = {
  document: NativeDocument
  mode: CaptureMode
  anchors: ArtifactAnchor[]
  onTarget(anchor: ArtifactAnchor): void
  onStatuses(statuses: TargetStatus[]): void
  onReady?(): void
  onError?(message: string): void
  onInteracting?(active: boolean): void
}

/** The artifact stays in an opaque-origin frame; messages can report targets, never invoke server actions. */
export function ArtifactFrame(props: ArtifactFrameProps) {
  const frame = useRef<HTMLIFrameElement>(null)
  const latest = useRef(props)
  latest.current = props
  const [readyChannel, setReadyChannel] = useState('')
  const [notice, setNotice] = useState('Loading artifact…')
  const channel = props.document.channel
  const post = useCallback(
    (message: object) => {
      // An opaque sandbox has no addressable origin. '*' is necessary, and only this exact frame window receives it.
      frame.current?.contentWindow?.postMessage({ ...message, channel }, '*')
    },
    [channel],
  )
  useEffect(() => {
    setNotice('Loading artifact…')
    setReadyChannel('')
    latest.current.onInteracting?.(false)
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== 'null') return
      const message = decodeFrameMessage(event.data, channel)
      if (!message) return
      const current = latest.current
      if (message.type === 'ready') {
        setReadyChannel(channel)
        setNotice('Artifact ready.')
        current.onReady?.()
      } else if (message.type === 'target') {
        if (current.mode !== 'annotate') return
        setNotice(message.anchor.kind === 'text' ? 'Text selection captured.' : 'Element captured.')
        current.onTarget(message.anchor)
      } else if (message.type === 'interaction') {
        current.onInteracting?.(message.active && current.mode === 'annotate')
      } else if (message.type === 'statuses') {
        if (message.statuses.length === current.anchors.length) current.onStatuses(message.statuses)
      } else {
        setNotice(message.message)
        current.onError?.(message.message)
      }
    }
    window.addEventListener('message', receive)
    return () => {
      window.removeEventListener('message', receive)
      latest.current.onInteracting?.(false)
    }
  }, [channel])
  useEffect(() => {
    if (props.mode !== 'annotate') latest.current.onInteracting?.(false)
    if (readyChannel === channel)
      post({ type: 'configure', mode: props.mode, anchors: props.anchors.slice(0, 200) })
  }, [readyChannel, channel, props.mode, props.anchors, post])
  return (
    <div className="flex h-full min-h-0 flex-col">
      <iframe
        key={channel}
        ref={frame}
        title={props.document.artifact.title || 'HTML artifact'}
        srcDoc={props.document.srcdoc}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        className="min-h-0 w-full flex-1 border-0 bg-white"
        onError={() => {
          const message = 'The artifact could not be loaded.'
          setNotice(message)
          latest.current.onError?.(message)
        }}
      />
      <p role="status" aria-live="polite" className="sr-only">
        {notice}
      </p>
    </div>
  )
}
