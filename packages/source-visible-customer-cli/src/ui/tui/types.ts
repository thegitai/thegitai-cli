export interface TuiSpan {
  text: string;
  color?: string;
  bgColor?: string;
  bold?: boolean;
  dim?: boolean;
  inverse?: boolean;
  underline?: boolean;
  linkUrl?: string;
}

export interface TuiLine {
  spans: TuiSpan[];
}

export interface TuiSection {
  kind: 'transcript' | 'live' | 'busyFooter' | 'composer' | 'overlay';
  lines: TuiLine[];
}

export interface TuiFrame {
  cols: number;
  rows: number;
  gutter: number;
  contentWidth: number;
  spinnerFrame: number;
  transcriptScrollLimit: number;
  transcriptScrollOffset: number;
  sections: TuiSection[];
}

export type TuiKeyEvent = {
  input: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  escape: boolean;
  returnKey: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  home: boolean;
  end: boolean;
  paste: boolean;
  pageUp: boolean;
  pageDown: boolean;
};

export type TuiChildMessage =
  | { op: 'ready'; cols: number; rows: number }
  | { op: 'event'; kind: 'key'; input: string; ctrl: boolean; meta: boolean; shift: boolean; escape: boolean; returnKey: boolean; tab: boolean; backspace: boolean; delete: boolean; upArrow: boolean; downArrow: boolean; leftArrow: boolean; rightArrow: boolean; home: boolean; end: boolean; paste: boolean; pageUp: boolean; pageDown: boolean }
  | { op: 'event'; kind: 'paste'; text: string }
  | { op: 'event'; kind: 'resize'; cols: number; rows: number }
  | { op: 'event'; kind: 'selectionCopy'; text: string }
  | { op: 'event'; kind: 'linkCopy'; url: string }
  | { op: 'event'; kind: 'linkOpen'; url: string }
  | { op: 'event'; kind: 'contextMenu' }
  | { op: 'event'; kind: 'transcriptScroll'; deltaLines: number }
  | { op: 'event'; kind: 'transcriptScrollTo'; offset: number }
  | { op: 'closed' };
