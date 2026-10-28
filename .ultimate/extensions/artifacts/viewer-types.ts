import type { Artifact, LayoutPassInput } from './types.ts'

/** Passive document returned by the native artifact loader; never insert srcdoc into the host DOM. */
export type NativeDocument = {
  artifact: Artifact
  srcdoc: string
  channel: string
  sourceError?: string
}

export type TargetStatus = 'same' | 'changed' | 'missing'
export type CaptureMode = 'view' | 'annotate'

/** CSS pixel coordinates relative to the iframe viewport, never the outer host window. */
export type TargetRect = { x: number; y: number; width: number; height: number }
export type LayoutDiagnostics = Omit<LayoutPassInput, 'artifactId' | 'contentHash'>
export type RevealTarget = { selector: string; request: number }
