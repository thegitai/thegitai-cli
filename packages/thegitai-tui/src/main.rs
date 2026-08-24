mod protocol;
mod render;

use std::io::{self, BufRead, BufReader, Write};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use crossterm::event::{
    self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent,
    MouseEventKind,
};
use crossterm::event::{DisableBracketedPaste, EnableBracketedPaste};
use crossterm::event::{DisableMouseCapture, EnableMouseCapture};
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen, SetTitle,
};
use crossterm::ExecutableCommand;
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;

use crate::protocol::{ChildMessage, ParentMessage, TuiEvent, TuiFrame};
use crate::render::{
    render_sections, transcript_scrollbar_offset_for_row, RenderSnapshot, RenderedTranscript,
    ScrollbarHitTarget, SelectionOverlay, SelectionPoint, TranscriptScroll,
};

#[cfg(unix)]
use std::fs::{File, OpenOptions};

#[cfg(test)]
use crate::render::RenderedLink;

const ENABLE_ALTERNATE_SCROLL: &[u8] = b"\x1b[?1007h";
const DISABLE_ALTERNATE_SCROLL: &[u8] = b"\x1b[?1007l";
const WHEEL_KEY_BURST_WINDOW: Duration = Duration::from_millis(12);
const WHEEL_SCROLL_LINES: i16 = 8;
const DRAG_SCROLL_LINES: i16 = 1;
const DRAG_SCROLL_INTERVAL: Duration = Duration::from_millis(50);
const MULTI_CLICK_TIMEOUT: Duration = Duration::from_millis(500);
const MULTI_CLICK_DISTANCE: i32 = 1;
const MIN_DRAG_SELECTION_CHARS: usize = 3;

#[cfg(unix)]
type RenderWriter = File;

#[cfg(windows)]
type RenderWriter = io::Stdout;

enum PendingInput {
    Arrow(KeyEvent, Instant),
    Wheel(KeyCode, Instant),
}

#[derive(Debug, Default)]
struct ScrollbarDrag {
    active: bool,
    hit: Option<ScrollbarHitTarget>,
    last_emitted_offset: Option<usize>,
}

impl ScrollbarDrag {
    fn clear(&mut self) {
        *self = Self::default();
    }

    fn start(&mut self, hit: ScrollbarHitTarget, offset: usize) {
        self.active = true;
        self.hit = Some(hit);
        self.last_emitted_offset = Some(offset);
    }

    fn finish(&mut self) {
        self.clear();
    }
}

/// A live selection, held in the content rows of the surface it was made on.
///
/// Transcript points are the parent's absolute transcript line indices, so the
/// highlight rides its own text as the viewport scrolls instead of staying
/// parked on fixed screen rows. Points on the pinned surface (composer, footer)
/// are screen rows; that surface does not scroll. `transcript_anchored` says
/// which space is in play and which surface every lookup must go through.
#[derive(Debug, Default)]
struct MouseSelection {
    anchor: Option<SelectionPoint>,
    focus: Option<SelectionPoint>,
    dragging: bool,
    dragged: bool,
    selected_by_click: bool,
    transcript_anchored: bool,
    last_mouse_row: Option<i32>,
    last_scroll_delta: i16,
    scrolled_off_above: Vec<String>,
    scrolled_off_below: Vec<String>,
    copied_text: Option<String>,
}

impl MouseSelection {
    fn clear(&mut self) {
        *self = Self::default();
    }

    fn start(&mut self, point: SelectionPoint, mouse_row: i32, transcript_anchored: bool) {
        self.clear();
        self.anchor = Some(point);
        self.dragging = true;
        self.dragged = false;
        self.selected_by_click = false;
        self.transcript_anchored = transcript_anchored;
        self.last_mouse_row = Some(mouse_row);
    }

    fn drag_to(&mut self, point: SelectionPoint, mouse_row: i32) {
        if !self.dragging {
            return;
        }
        self.last_mouse_row = Some(mouse_row);
        self.focus = Some(point);
    }

    fn drag_to_if_threshold(
        &mut self,
        transcript: &RenderedTranscript,
        point: SelectionPoint,
        mouse_row: i32,
    ) {
        if !self.dragging {
            return;
        }
        self.last_mouse_row = Some(mouse_row);
        if self.dragged
            || self
                .anchor
                .map(|anchor| selection_char_count(transcript, anchor, point))
                .unwrap_or(0)
                >= MIN_DRAG_SELECTION_CHARS
        {
            self.dragged = true;
            self.focus = Some(point);
        }
    }

    fn select_word_at(
        &mut self,
        surface: &RenderedTranscript,
        point: SelectionPoint,
        mouse_row: i32,
        transcript_anchored: bool,
    ) {
        let Some((start, end)) = word_bounds_at(surface, point) else {
            self.clear();
            return;
        };
        self.anchor = Some(start);
        self.focus = Some(end);
        self.dragging = true;
        self.dragged = false;
        self.selected_by_click = true;
        self.transcript_anchored = transcript_anchored;
        self.last_mouse_row = Some(mouse_row);
    }

    fn select_row_at(
        &mut self,
        surface: &RenderedTranscript,
        point: SelectionPoint,
        mouse_row: i32,
        transcript_anchored: bool,
    ) {
        let Some(end) = row_end_point(surface, point.row) else {
            self.clear();
            return;
        };
        self.anchor = Some(SelectionPoint {
            row: point.row,
            col: 0,
        });
        self.focus = Some(end);
        self.dragging = true;
        self.dragged = false;
        self.selected_by_click = true;
        self.transcript_anchored = transcript_anchored;
        self.last_mouse_row = Some(mouse_row);
    }

    fn finish(&mut self, transcript: Option<&RenderedTranscript>) -> Option<String> {
        if !self.dragging {
            return None;
        }
        self.dragging = false;
        self.last_mouse_row = None;
        self.last_scroll_delta = 0;
        if !self.dragged && !self.selected_by_click {
            self.clear();
            return None;
        }
        // Click-selections (double-click word, triple-click row) copy on release
        // just like a drag selection. Only a plain single click, caught by the
        // guard above, finishes without copying.
        let text = self.read_text(transcript?)?;
        self.copied_text = Some(text.clone());
        Some(text)
    }

    /// Text for a copy request against a selection that already exists.
    ///
    /// Prefers what was captured when the selection was completed: only the
    /// visible rows can be read back from the surface, and by now the user may
    /// have scrolled some of the selected text out of the viewport.
    fn copy_text(&self, transcript: &RenderedTranscript) -> Option<String> {
        self.copied_text
            .clone()
            .or_else(|| self.read_text(transcript))
    }

    fn read_text(&self, transcript: &RenderedTranscript) -> Option<String> {
        let text = self.selected_text(transcript);
        if text.trim().is_empty() {
            None
        } else {
            Some(text)
        }
    }

    fn overlay(&self) -> Option<SelectionOverlay> {
        if !self.dragged && !self.selected_by_click {
            return None;
        }
        let (start, end) = self.bounds()?;
        Some(SelectionOverlay {
            start,
            end,
            anchored_to_transcript: self.transcript_anchored,
        })
    }

    fn bounds(&self) -> Option<(SelectionPoint, SelectionPoint)> {
        let anchor = self.anchor?;
        let focus = self.focus?;
        if (focus.row, focus.col) < (anchor.row, anchor.col) {
            Some((focus, anchor))
        } else {
            Some((anchor, focus))
        }
    }

    fn selected_text(&self, transcript: &RenderedTranscript) -> String {
        let Some((start, end)) = self.bounds() else {
            return String::new();
        };
        let mut lines = Vec::new();
        lines.extend(self.scrolled_off_above.iter().cloned());
        // Only the rows the surface still holds can be read back; the ones the
        // drag scrolled past were captured into scrolled_off_* on their way out.
        let first = start.row.max(transcript.first_row);
        let last = end.row.min(transcript.last_row());
        if first <= last {
            for row in first..=last {
                if let Some(text) = selected_row_text(transcript, start, end, row) {
                    lines.push(text);
                }
            }
        }
        lines.extend(self.scrolled_off_below.iter().cloned());
        lines.join("\n")
    }

    /// Fold one step of a drag-scroll into the selection, before the parent
    /// sends the scrolled frame.
    ///
    /// The anchor needs no fixing up — it is a content row and stays on its own
    /// line — but two things still have to happen by hand. The row about to
    /// leave the viewport is kept, because the surface only ever hands back
    /// text it is currently showing. And the focus is walked one row further in
    /// the scroll direction: the pointer is parked at the edge and emits no
    /// further drag events, so without this the viewport would keep moving
    /// while the selection stopped growing.
    fn capture_for_scroll(&mut self, transcript: &RenderedTranscript, delta: i16) {
        if delta == 0 {
            return;
        }
        if self.last_scroll_delta != 0 && self.last_scroll_delta.signum() != delta.signum() {
            self.scrolled_off_above.clear();
            self.scrolled_off_below.clear();
        }
        self.last_scroll_delta = delta;
        let Some((start, end)) = self.bounds() else {
            return;
        };
        let Some(focus) = self.focus.as_mut() else {
            return;
        };
        if delta > 0 {
            // Scrolling toward older text pushes the viewport's last row out
            // and reveals one older row above the first.
            if let Some(text) = selected_row_text(transcript, start, end, transcript.last_row()) {
                self.scrolled_off_below.insert(0, text);
            }
            focus.row = transcript.first_row - 1;
            focus.col = 0;
        } else {
            if let Some(text) = selected_row_text(transcript, start, end, transcript.first_row) {
                self.scrolled_off_above.push(text);
            }
            focus.row = transcript.last_row() + 1;
            // The revealed row is not rendered yet; readers clamp the column to
            // whatever text it turns out to hold.
            focus.col = transcript.rect.width.saturating_sub(1);
        }
    }
}

fn selected_row_text(
    transcript: &RenderedTranscript,
    start: SelectionPoint,
    end: SelectionPoint,
    row: i64,
) -> Option<String> {
    if row < start.row || row > end.row {
        return None;
    }
    let text = transcript.line_at(row)?;
    let line_len = text.chars().count();
    if line_len == 0 {
        return Some(String::new());
    }
    let start_col = if row == start.row {
        usize::from(start.col)
    } else {
        0
    };
    let end_col = if row == end.row {
        usize::from(end.col)
    } else {
        line_len.saturating_sub(1)
    };
    if start_col >= line_len {
        return Some(String::new());
    }
    let end_col = end_col.min(line_len.saturating_sub(1));
    if start_col > end_col {
        return Some(String::new());
    }
    Some(
        text.chars()
            .skip(start_col)
            .take(end_col - start_col + 1)
            .collect(),
    )
}

fn selection_char_count(
    transcript: &RenderedTranscript,
    anchor: SelectionPoint,
    focus: SelectionPoint,
) -> usize {
    let (start, end) = if (focus.row, focus.col) < (anchor.row, anchor.col) {
        (focus, anchor)
    } else {
        (anchor, focus)
    };
    let first = start.row.max(transcript.first_row);
    let last = end.row.min(transcript.last_row());
    if first > last {
        return 0;
    }
    (first..=last)
        .filter_map(|row| selected_row_text(transcript, start, end, row))
        .map(|text| text.chars().count())
        .sum()
}

fn word_bounds_at(
    transcript: &RenderedTranscript,
    point: SelectionPoint,
) -> Option<(SelectionPoint, SelectionPoint)> {
    let line = transcript.line_at(point.row)?;
    let chars = line.chars().collect::<Vec<_>>();
    if chars.is_empty() {
        return None;
    }
    let index = usize::from(point.col).min(chars.len().saturating_sub(1));
    let class = selection_char_class(chars[index]);
    let mut start = index;
    while start > 0 && selection_char_class(chars[start - 1]) == class {
        start -= 1;
    }
    let mut end = index;
    while end + 1 < chars.len() && selection_char_class(chars[end + 1]) == class {
        end += 1;
    }
    Some((
        SelectionPoint {
            row: point.row,
            col: start as u16,
        },
        SelectionPoint {
            row: point.row,
            col: end as u16,
        },
    ))
}

fn row_end_point(transcript: &RenderedTranscript, row: i64) -> Option<SelectionPoint> {
    let line = transcript.line_at(row)?;
    let col = line.chars().count().max(1).saturating_sub(1) as u16;
    Some(SelectionPoint { row, col })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SelectionCharClass {
    Word,
    Whitespace,
    Punctuation,
}

fn selection_char_class(ch: char) -> SelectionCharClass {
    if ch.is_whitespace() {
        SelectionCharClass::Whitespace
    } else if ch.is_alphanumeric() || matches!(ch, '_' | '-' | '/' | '.' | ':' | '~' | '+') {
        SelectionCharClass::Word
    } else {
        SelectionCharClass::Punctuation
    }
}

fn point_in_transcript(
    transcript: &RenderedTranscript,
    column: u16,
    row: u16,
) -> Option<SelectionPoint> {
    if column < transcript.rect.x
        || column >= transcript.rect.right()
        || row < transcript.rect.y
        || row
            >= transcript
                .rect
                .y
                .saturating_add(transcript.lines.len() as u16)
    {
        return None;
    }
    Some(clamp_point_to_transcript(transcript, column, row))
}

fn url_at_point(transcript: &RenderedTranscript, column: u16, row: u16) -> Option<String> {
    if column < transcript.rect.x
        || column >= transcript.rect.right()
        || row < transcript.rect.y
        || row
            >= transcript
                .rect
                .y
                .saturating_add(transcript.lines.len() as u16)
    {
        return None;
    }
    let local_col = column.saturating_sub(transcript.rect.x);
    // Links are hit-tested against the frame on screen, so they stay in screen
    // rows — unlike a selection, nothing carries them across a scroll.
    for link in &transcript.links {
        if link.row == row && local_col >= link.start_col && local_col <= link.end_col {
            return Some(link.url.clone());
        }
    }
    let line = transcript.line_at(transcript.content_row(row))?;
    let col = usize::from(local_col);
    url_at_column(line, col)
}

fn url_at_column(line: &str, col: usize) -> Option<String> {
    let chars: Vec<char> = line.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        let Some(prefix_len) = url_prefix_len_at(&chars, index) else {
            index += 1;
            continue;
        };
        let mut end = index + prefix_len;
        while end < chars.len() && !is_url_boundary(chars[end]) {
            end += 1;
        }
        while end > index && is_url_trailing_punctuation(chars[end - 1]) {
            end -= 1;
        }
        if col >= index && col < end {
            return Some(chars[index..end].iter().collect());
        }
        index = (index + prefix_len).max(end);
    }
    None
}

fn url_prefix_len_at(chars: &[char], start: usize) -> Option<usize> {
    const HTTPS: &str = "https://";
    const HTTP: &str = "http://";
    if chars_match(chars, start, HTTPS) {
        Some(HTTPS.len())
    } else if chars_match(chars, start, HTTP) {
        Some(HTTP.len())
    } else {
        None
    }
}

fn chars_match(chars: &[char], start: usize, value: &str) -> bool {
    value
        .chars()
        .enumerate()
        .all(|(offset, expected)| chars.get(start + offset) == Some(&expected))
}

fn is_url_trailing_punctuation(ch: char) -> bool {
    matches!(
        ch,
        ')' | ']' | '}' | '>' | '.' | ',' | ';' | ':' | '!' | '?'
    )
}

fn is_url_boundary(ch: char) -> bool {
    ch.is_whitespace() || matches!(ch, ')' | ']' | '}' | '>')
}

fn clamp_point_to_transcript(
    transcript: &RenderedTranscript,
    column: u16,
    row: u16,
) -> SelectionPoint {
    let row = transcript
        .content_row(row)
        .clamp(transcript.first_row, transcript.last_row());
    let line_len = transcript
        .line_at(row)
        .map(|line| line.chars().count())
        .unwrap_or_default()
        .max(1);
    let col = column
        .clamp(transcript.rect.x, transcript.rect.right().saturating_sub(1))
        .saturating_sub(transcript.rect.x);
    SelectionPoint {
        row,
        col: col.min(line_len.saturating_sub(1) as u16),
    }
}

#[derive(Debug, Default)]
struct MouseClickState {
    last_click: Option<LastClick>,
    pending_link_open: Option<PendingLinkOpen>,
}

#[derive(Clone, Copy, Debug)]
struct LastClick {
    column: u16,
    row: u16,
    count: u8,
    at: Instant,
}

#[derive(Clone, Debug)]
struct PendingLinkOpen {
    url: String,
    due: Instant,
}

impl MouseClickState {
    fn register_left_down(&mut self, column: u16, row: u16, now: Instant) -> u8 {
        let count = self
            .last_click
            .filter(|last| {
                now.duration_since(last.at) <= MULTI_CLICK_TIMEOUT
                    && (i32::from(column) - i32::from(last.column)).abs() <= MULTI_CLICK_DISTANCE
                    && (i32::from(row) - i32::from(last.row)).abs() <= MULTI_CLICK_DISTANCE
            })
            .map(|last| last.count.saturating_add(1).min(3))
            .unwrap_or(1);
        self.last_click = Some(LastClick {
            column,
            row,
            count,
            at: now,
        });
        count
    }

    fn schedule_link_open(&mut self, url: String, now: Instant) {
        self.pending_link_open = Some(PendingLinkOpen {
            url,
            due: now + MULTI_CLICK_TIMEOUT,
        });
    }

    fn clear_pending_link_open(&mut self) {
        self.pending_link_open = None;
    }

    fn take_due_link_open(&mut self, now: Instant) -> Option<TuiEvent> {
        let pending = self.pending_link_open.take()?;
        if now >= pending.due {
            Some(TuiEvent::LinkOpen { url: pending.url })
        } else {
            self.pending_link_open = Some(pending);
            None
        }
    }
}

fn can_scroll(frame: &TuiFrame, delta_lines: i16) -> bool {
    if delta_lines > 0 {
        frame.transcript_scroll_offset < frame.transcript_scroll_limit
    } else if delta_lines < 0 {
        frame.transcript_scroll_offset > 0
    } else {
        false
    }
}

fn predicted_scroll_offset(frame: &TuiFrame, delta_lines: i16) -> usize {
    if delta_lines > 0 {
        frame
            .transcript_scroll_offset
            .saturating_add(delta_lines as usize)
            .min(frame.transcript_scroll_limit)
    } else {
        frame
            .transcript_scroll_offset
            .saturating_sub(delta_lines.unsigned_abs() as usize)
    }
}

fn drag_scroll_delta(
    selection: &MouseSelection,
    transcript: &RenderedTranscript,
    frame: &TuiFrame,
) -> i16 {
    if !selection.dragging || !selection.transcript_anchored || selection.focus.is_none() {
        return 0;
    }
    let Some(row) = selection.last_mouse_row else {
        return 0;
    };
    if row <= i32::from(transcript.rect.y) && can_scroll(frame, DRAG_SCROLL_LINES) {
        return DRAG_SCROLL_LINES;
    }
    if row >= i32::from(transcript.rect.bottom().saturating_sub(1))
        && can_scroll(frame, -DRAG_SCROLL_LINES)
    {
        return -DRAG_SCROLL_LINES;
    }
    0
}

fn scrollbar_scroll_to_event(
    hit: ScrollbarHitTarget,
    mouse_row: u16,
) -> (usize, TuiEvent) {
    let offset =
        transcript_scrollbar_offset_for_row(hit.limit, hit.y, hit.height, mouse_row);
    (
        offset,
        TuiEvent::TranscriptScrollTo { offset },
    )
}

fn mouse_event_to_messages(
    selection: &mut MouseSelection,
    click_state: &mut MouseClickState,
    scrollbar_drag: &mut ScrollbarDrag,
    snapshot: &RenderSnapshot,
    frame: Option<&TuiFrame>,
    mouse: MouseEvent,
    now: Instant,
) -> Vec<TuiEvent> {
    let transcript = snapshot.transcript.as_ref();
    let surface = snapshot.selection_surface.as_ref().or(transcript);
    match mouse.kind {
        MouseEventKind::ScrollUp => {
            click_state.clear_pending_link_open();
            scrollbar_drag.clear();
            if frame
                .map(|frame| can_scroll(frame, WHEEL_SCROLL_LINES))
                .unwrap_or(false)
            {
                vec![TuiEvent::TranscriptScroll {
                    delta_lines: WHEEL_SCROLL_LINES,
                }]
            } else {
                Vec::new()
            }
        }
        MouseEventKind::ScrollDown => {
            click_state.clear_pending_link_open();
            scrollbar_drag.clear();
            if frame
                .map(|frame| can_scroll(frame, -WHEEL_SCROLL_LINES))
                .unwrap_or(false)
            {
                vec![TuiEvent::TranscriptScroll {
                    delta_lines: -WHEEL_SCROLL_LINES,
                }]
            } else {
                Vec::new()
            }
        }
        MouseEventKind::Down(MouseButton::Left) => {
            click_state.clear_pending_link_open();
            if let Some(hit) = snapshot.scrollbar.filter(|hit| hit.contains(mouse.column, mouse.row))
            {
                selection.clear();
                let (offset, event) = scrollbar_scroll_to_event(hit, mouse.row);
                scrollbar_drag.start(hit, offset);
                return vec![event];
            }
            scrollbar_drag.clear();
            let Some(surface) = surface else {
                return Vec::new();
            };
            // Points inside the transcript are recorded on the transcript
            // itself, so they land in its content rows and ride the text as it
            // scrolls. Everything else is read off the pinned surface.
            let transcript_hit = transcript.filter(|transcript| {
                point_in_transcript(transcript, mouse.column, mouse.row).is_some()
            });
            let anchor_surface = transcript_hit.unwrap_or(surface);
            if let Some(point) = point_in_transcript(anchor_surface, mouse.column, mouse.row) {
                let anchored = transcript_hit.is_some();
                let mouse_row = i32::from(mouse.row);
                match click_state.register_left_down(mouse.column, mouse.row, now) {
                    1 => selection.start(point, mouse_row, anchored),
                    2 => selection.select_word_at(anchor_surface, point, mouse_row, anchored),
                    _ => selection.select_row_at(anchor_surface, point, mouse_row, anchored),
                }
            } else {
                selection.clear();
            }
            Vec::new()
        }
        MouseEventKind::Drag(MouseButton::Left) => {
            click_state.clear_pending_link_open();
            if scrollbar_drag.active {
                let hit = snapshot
                    .scrollbar
                    .or(scrollbar_drag.hit)
                    .filter(|hit| hit.height > 0);
                let Some(hit) = hit else {
                    return Vec::new();
                };
                scrollbar_drag.hit = Some(hit);
                let (offset, event) = scrollbar_scroll_to_event(hit, mouse.row);
                if scrollbar_drag.last_emitted_offset == Some(offset) {
                    return Vec::new();
                }
                scrollbar_drag.last_emitted_offset = Some(offset);
                return vec![event];
            }
            let Some(surface) = surface else {
                return Vec::new();
            };
            if selection.dragging {
                let drag_surface = if selection.transcript_anchored {
                    transcript.unwrap_or(surface)
                } else {
                    surface
                };
                let point = clamp_point_to_transcript(drag_surface, mouse.column, mouse.row);
                selection.drag_to_if_threshold(drag_surface, point, i32::from(mouse.row));
            }
            Vec::new()
        }
        MouseEventKind::Up(MouseButton::Left) => {
            if scrollbar_drag.active {
                scrollbar_drag.finish();
                return Vec::new();
            }
            let Some(surface) = surface else {
                return Vec::new();
            };
            if selection.dragging {
                let clicked_link = if selection.dragged || selection.selected_by_click {
                    None
                } else {
                    url_at_point(surface, mouse.column, mouse.row)
                };
                if selection.dragged || !selection.selected_by_click {
                    let drag_surface = if selection.transcript_anchored {
                        transcript.unwrap_or(surface)
                    } else {
                        surface
                    };
                    let point = clamp_point_to_transcript(drag_surface, mouse.column, mouse.row);
                    selection.drag_to(point, i32::from(mouse.row));
                }
                if let Some(url) = clicked_link {
                    selection.finish(Some(surface));
                    click_state.schedule_link_open(url, now);
                    return Vec::new();
                }
                let copy_surface = if selection.transcript_anchored {
                    transcript.unwrap_or(surface)
                } else {
                    surface
                };
                if let Some(text) = selection.finish(Some(copy_surface)) {
                    return vec![TuiEvent::SelectionCopy { text }];
                }
            }
            Vec::new()
        }
        MouseEventKind::Down(MouseButton::Right) => {
            click_state.clear_pending_link_open();
            let Some(surface) = surface else {
                return vec![TuiEvent::ContextMenu];
            };
            if let Some(url) = url_at_point(surface, mouse.column, mouse.row) {
                return vec![TuiEvent::LinkCopy { url }];
            }
            let copy_surface = if selection.transcript_anchored {
                transcript.unwrap_or(surface)
            } else {
                surface
            };
            if let Some(text) = selection.copy_text(copy_surface) {
                return vec![TuiEvent::SelectionCopy { text }];
            }
            if transcript
                .and_then(|transcript| point_in_transcript(transcript, mouse.column, mouse.row))
                .is_some()
            {
                return Vec::new();
            }
            vec![TuiEvent::ContextMenu]
        }
        _ => Vec::new(),
    }
}

/// Whether the transcript's text width changed between two frames.
///
/// That is the one thing a content-row selection cannot survive: a narrower or
/// wider transcript rewraps every line, so the parent's line numbering no
/// longer describes the text the selection was made on. It happens on a
/// horizontal resize and when the scrollbar appears or disappears, which
/// reserves two columns. A height-only resize is safe — nothing rewraps, and
/// the changed scroll limit already carries the window to the right lines.
fn transcript_rewrapped(previous: &RenderSnapshot, next: &RenderSnapshot) -> bool {
    match (previous.transcript.as_ref(), next.transcript.as_ref()) {
        (Some(previous), Some(next)) => previous.rect.width != next.rect.width,
        _ => false,
    }
}

fn maybe_drag_scroll_message(
    selection: &mut MouseSelection,
    snapshot: &RenderSnapshot,
    frame: Option<&TuiFrame>,
    pending_scroll_offset: &mut Option<usize>,
    last_drag_scroll_at: &mut Option<Instant>,
    now: Instant,
) -> Option<TuiEvent> {
    if pending_scroll_offset.is_some() {
        return None;
    }
    if last_drag_scroll_at
        .map(|last| now.duration_since(last) < DRAG_SCROLL_INTERVAL)
        .unwrap_or(false)
    {
        return None;
    }
    let transcript = snapshot.transcript.as_ref()?;
    let frame = frame?;
    let delta = drag_scroll_delta(selection, transcript, frame);
    if delta == 0 {
        return None;
    }
    selection.capture_for_scroll(transcript, delta);
    *pending_scroll_offset = Some(predicted_scroll_offset(frame, delta));
    *last_drag_scroll_at = Some(now);
    Some(TuiEvent::TranscriptScroll { delta_lines: delta })
}

/// Reader for the newline-delimited JSON protocol the parent sends us.
///
/// crossterm reads terminal *input* from stdin when stdin is a tty, otherwise
/// it falls back to opening `/dev/tty`. macOS `kqueue` cannot register
/// `/dev/tty` for readiness (Linux `epoll` can), so when the Node bridge hands
/// us a pipe on stdin — which it does, using stdin for this JSON protocol —
/// crossterm's input reader fails to initialize on macOS ("Failed to initialize
/// input reader"). Our stdout is inherited from the real terminal (a pollable
/// pts), so on macOS we re-point stdin at that pts and keep reading the protocol
/// from the original stdin fd. Linux/Windows keep reading stdin unchanged.
#[cfg(target_os = "macos")]
fn protocol_input_reader() -> Box<dyn io::Read + Send> {
    use std::ffi::CStr;
    use std::os::unix::io::{FromRawFd, IntoRawFd};

    unsafe {
        // Act only when stdin isn't already a usable tty (it's the Node protocol
        // pipe). Borrow whichever inherited descriptor is the controlling
        // terminal — stdout normally, stderr as a fallback — resolve it to its
        // pts path, and re-point stdin at a fresh handle so crossterm reads a
        // kqueue-registrable pts instead of falling back to /dev/tty. We open the
        // pts fresh rather than dup2-ing the borrowed fd so crossterm's
        // nonblocking mode stays off that fd's shared file description.
        if libc::isatty(libc::STDIN_FILENO) == 0 {
            for &fd in &[libc::STDOUT_FILENO, libc::STDERR_FILENO] {
                if libc::isatty(fd) != 1 {
                    continue;
                }
                let mut buf = [0 as libc::c_char; 256];
                if libc::ttyname_r(fd, buf.as_mut_ptr(), buf.len()) != 0 {
                    continue;
                }
                let Ok(path) = CStr::from_ptr(buf.as_ptr()).to_str() else {
                    continue;
                };
                let Ok(tty) = OpenOptions::new().read(true).write(true).open(path) else {
                    continue;
                };
                let saved = libc::dup(libc::STDIN_FILENO);
                let tty_fd = tty.into_raw_fd();
                if saved >= 0 && libc::dup2(tty_fd, libc::STDIN_FILENO) >= 0 {
                    libc::close(tty_fd);
                    return Box::new(File::from_raw_fd(saved));
                }
                libc::close(tty_fd);
            }
        }
    }
    // No inherited tty to borrow (e.g. stdout redirected by a wrapper).
    // crossterm then falls back to /dev/tty, which macOS kqueue cannot register.
    Box::new(io::stdin())
}

#[cfg(not(target_os = "macos"))]
fn protocol_input_reader() -> Box<dyn io::Read + Send> {
    Box::new(io::stdin())
}

fn main() -> Result<()> {
    let mut protocol_out = io::stderr();
    let (frame_tx, frame_rx) = mpsc::channel::<ParentMessage>();
    let protocol_in = protocol_input_reader();
    thread::spawn(move || {
        let reader = BufReader::new(protocol_in);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            let Ok(message) = serde_json::from_str::<ParentMessage>(&line) else {
                continue;
            };
            if frame_tx.send(message).is_err() {
                break;
            }
        }
    });

    let mut setup_out = open_render_writer().context(
        "TheGitAI TUI requires an interactive terminal. Run `ai` from a real terminal, not a pipe or headless job.",
    )?;
    let render_out = open_render_writer().context("open terminal for rendering")?;

    ensure_virtual_terminal_processing().context("enable Windows virtual terminal processing")?;
    enable_raw_mode().context("enable raw mode")?;
    setup_out
        .execute(EnterAlternateScreen)
        .context("enter alternate screen")?;
    // Enable bracketed paste so the terminal wraps pasted text in escape
    // markers and crossterm emits a single Event::Paste. Without this, pasted
    // text arrives as individual key events (newlines as Enter), which breaks
    // the "[Pasted N lines]" collapse and submits multi-line pastes. See #308.
    setup_out
        .execute(EnableBracketedPaste)
        .context("enable bracketed paste")?;
    setup_out
        .write_all(ENABLE_ALTERNATE_SCROLL)
        .context("enable alternate scroll")?;
    setup_out
        .execute(EnableMouseCapture)
        .context("enable mouse capture")?;

    // Restore the terminal on every exit path: normal return, `?` error, or panic.
    let _terminal_guard = TerminalGuard;
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        restore_terminal();
        previous_hook(info);
    }));

    let backend = CrosstermBackend::new(render_out);
    let mut terminal = Terminal::new(backend)?;

    let frame_state: Arc<Mutex<Option<TuiFrame>>> = Arc::new(Mutex::new(None));
    let mut quit = false;
    let mut pending_input: Option<PendingInput> = None;
    let mut render_snapshot = RenderSnapshot::default();
    let mut selection = MouseSelection::default();
    let mut click_state = MouseClickState::default();
    let mut scrollbar_drag = ScrollbarDrag::default();
    let mut scrollbar_hot = false;
    let mut pending_scroll_offset: Option<usize> = None;
    let mut last_drag_scroll_at: Option<Instant> = None;

    let (cols, rows) = terminal.size().map(|size| (size.width, size.height))?;
    write_child_message(&mut protocol_out, &ChildMessage::Ready { cols, rows })?;

    while !quit {
        while let Ok(message) = frame_rx.try_recv() {
            match message {
                ParentMessage::Frame(frame) => {
                    pending_scroll_offset = None;
                    *frame_state.lock().expect("frame lock") = Some(frame);
                }
                ParentMessage::Clear => {
                    selection.clear();
                    click_state.clear_pending_link_open();
                    scrollbar_drag.clear();
                    scrollbar_hot = false;
                    terminal.clear()?;
                }
                ParentMessage::Title { text } => {
                    // Written here, never by the parent: this process owns the
                    // terminal, and a second writer's escape can interleave with a
                    // frame flush and corrupt it.
                    io::stdout().execute(SetTitle(text.as_str()))?;
                }
                ParentMessage::Quit => {
                    quit = true;
                }
            }
        }

        flush_pending_input(&mut protocol_out, &mut pending_input)?;

        let frame_for_scroll = frame_state.lock().expect("frame lock").clone();
        if let Some(message) = maybe_drag_scroll_message(
            &mut selection,
            &render_snapshot,
            frame_for_scroll.as_ref(),
            &mut pending_scroll_offset,
            &mut last_drag_scroll_at,
            Instant::now(),
        ) {
            click_state.clear_pending_link_open();
            write_child_message(&mut protocol_out, &ChildMessage::Event(message))?;
        }

        if let Some(message) = click_state.take_due_link_open(Instant::now()) {
            write_child_message(&mut protocol_out, &ChildMessage::Event(message))?;
        }

        if event::poll(Duration::from_millis(50))? {
            match event::read()? {
                Event::Key(key) => {
                    click_state.clear_pending_link_open();
                    if selection.overlay().is_some() && key.code == KeyCode::Esc {
                        selection.clear();
                        continue;
                    }
                    for message in
                        key_event_to_messages_with_pending(key, &mut pending_input, Instant::now())
                    {
                        write_child_message(&mut protocol_out, &ChildMessage::Event(message))?;
                    }
                }
                Event::Paste(text) => {
                    click_state.clear_pending_link_open();
                    write_child_message(
                        &mut protocol_out,
                        &ChildMessage::Event(TuiEvent::Paste { text }),
                    )?;
                }
                Event::Resize(width, height) => {
                    click_state.clear_pending_link_open();
                    terminal.resize(ratatui::layout::Rect::new(0, 0, width, height))?;
                    write_child_message(
                        &mut protocol_out,
                        &ChildMessage::Event(TuiEvent::Resize {
                            cols: width,
                            rows: height,
                        }),
                    )?;
                }
                Event::Mouse(mouse) => {
                    let frame = frame_state.lock().expect("frame lock").clone();
                    for message in mouse_event_to_messages(
                        &mut selection,
                        &mut click_state,
                        &mut scrollbar_drag,
                        &render_snapshot,
                        frame.as_ref(),
                        mouse,
                        Instant::now(),
                    ) {
                        write_child_message(&mut protocol_out, &ChildMessage::Event(message))?;
                    }
                    scrollbar_hot = scrollbar_drag.active
                        || render_snapshot
                            .scrollbar
                            .is_some_and(|hit| hit.contains(mouse.column, mouse.row));
                }
                _ => {}
            }
        }

        let frame = frame_state.lock().expect("frame lock").clone();
        if let Some(frame) = frame {
            let mut next_snapshot = RenderSnapshot::default();
            terminal.draw(|f| {
                let area = f.area();
                let content_width = frame.content_width.min(area.width);
                let gutter = frame.gutter.min(area.width.saturating_sub(content_width));
                next_snapshot = render_sections(
                    f,
                    &frame.sections,
                    ratatui::layout::Rect {
                        x: area.x.saturating_add(gutter),
                        y: area.y,
                        width: content_width,
                        height: area.height,
                    },
                    selection.overlay(),
                    TranscriptScroll {
                        offset: frame.transcript_scroll_offset,
                        limit: frame.transcript_scroll_limit,
                        hot: scrollbar_hot,
                    },
                );
            })?;
            if transcript_rewrapped(&render_snapshot, &next_snapshot) {
                selection.clear();
            }
            render_snapshot = next_snapshot;
        }
    }

    // _terminal_guard restores raw mode / alternate screen / mouse capture on drop.
    write_child_message(&mut protocol_out, &ChildMessage::Closed)?;
    Ok(())
}

#[cfg(unix)]
fn open_render_writer() -> io::Result<RenderWriter> {
    OpenOptions::new().read(true).write(true).open("/dev/tty")
}

#[cfg(windows)]
fn open_render_writer() -> io::Result<RenderWriter> {
    Ok(io::stdout())
}

fn restore_terminal() {
    let _ = disable_raw_mode();
    if let Ok(mut out) = open_render_writer() {
        let _ = out.write_all(DISABLE_ALTERNATE_SCROLL);
        let _ = out.execute(DisableBracketedPaste);
        let _ = out.execute(DisableMouseCapture);
        let _ = out.execute(LeaveAlternateScreen);
    }
}

struct TerminalGuard;

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        restore_terminal();
    }
}

fn write_child_message<W: Write>(writer: &mut W, message: &ChildMessage) -> Result<()> {
    let payload = serde_json::to_string(message)?;
    writeln!(writer, "{payload}")?;
    writer.flush()?;
    Ok(())
}

#[cfg(windows)]
fn ensure_virtual_terminal_processing() -> io::Result<()> {
    use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Console::{
        GetConsoleMode, GetStdHandle, SetConsoleMode, ENABLE_PROCESSED_OUTPUT,
        ENABLE_VIRTUAL_TERMINAL_PROCESSING, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE,
    };

    fn enable_for_handle(handle: HANDLE) -> io::Result<()> {
        if handle == INVALID_HANDLE_VALUE || handle.is_null() {
            return Ok(());
        }

        let mut mode = 0;
        if unsafe { GetConsoleMode(handle, &mut mode) } == 0 {
            return Ok(());
        }

        let requested = ENABLE_PROCESSED_OUTPUT | ENABLE_VIRTUAL_TERMINAL_PROCESSING;
        if mode & requested == requested {
            return Ok(());
        }

        if unsafe { SetConsoleMode(handle, mode | requested) } == 0 {
            return Err(io::Error::last_os_error());
        }

        Ok(())
    }

    enable_for_handle(unsafe { GetStdHandle(STD_OUTPUT_HANDLE) })?;
    enable_for_handle(unsafe { GetStdHandle(STD_ERROR_HANDLE) })?;
    Ok(())
}

#[cfg(not(windows))]
fn ensure_virtual_terminal_processing() -> io::Result<()> {
    Ok(())
}

fn key_event_to_messages_with_pending(
    key: KeyEvent,
    pending_input: &mut Option<PendingInput>,
    now: Instant,
) -> Vec<TuiEvent> {
    if let Some(pending) = pending_input.take() {
        match pending {
            PendingInput::Arrow(pending_key, started_at) => {
                if is_plain_vertical_arrow_key(key)
                    && key.code == pending_key.code
                    && now.duration_since(started_at) <= WHEEL_KEY_BURST_WINDOW
                {
                    *pending_input = Some(PendingInput::Wheel(key.code, now));
                    return vec![scroll_key_event(key.code == KeyCode::Up)];
                }

                let mut messages = Vec::new();
                if let Some(message) = key_event_to_message(pending_key) {
                    messages.push(message);
                }
                if is_plain_vertical_arrow_key(key) {
                    *pending_input = Some(PendingInput::Arrow(key, now));
                } else if let Some(message) = key_event_to_message(key) {
                    messages.push(message);
                }
                return messages;
            }
            PendingInput::Wheel(code, started_at) => {
                if is_plain_vertical_arrow_key(key)
                    && key.code == code
                    && now.duration_since(started_at) <= WHEEL_KEY_BURST_WINDOW
                {
                    *pending_input = Some(PendingInput::Wheel(code, now));
                    return Vec::new();
                }
                if is_plain_vertical_arrow_key(key) {
                    *pending_input = Some(PendingInput::Arrow(key, now));
                    return Vec::new();
                }
                return key_event_to_message(key).into_iter().collect();
            }
        }
    }

    if is_plain_vertical_arrow_key(key) {
        *pending_input = Some(PendingInput::Arrow(key, now));
        return Vec::new();
    }

    key_event_to_message(key).into_iter().collect()
}

fn flush_pending_input<W: Write>(
    protocol_out: &mut W,
    pending_input: &mut Option<PendingInput>,
) -> Result<()> {
    match pending_input {
        Some(PendingInput::Arrow(_, started_at)) | Some(PendingInput::Wheel(_, started_at))
            if started_at.elapsed() >= WHEEL_KEY_BURST_WINDOW =>
        {
            let Some(pending) = pending_input.take() else {
                return Ok(());
            };
            if let PendingInput::Arrow(key, _) = pending {
                if let Some(message) = key_event_to_message(key) {
                    write_child_message(protocol_out, &ChildMessage::Event(message))?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn is_plain_vertical_arrow_key(key: KeyEvent) -> bool {
    key.kind == KeyEventKind::Press
        && key.modifiers.is_empty()
        && matches!(key.code, KeyCode::Up | KeyCode::Down)
}

fn scroll_key_event(page_up: bool) -> TuiEvent {
    TuiEvent::Key {
        input: String::new(),
        ctrl: false,
        meta: false,
        shift: false,
        escape: false,
        return_key: false,
        tab: false,
        backspace: false,
        delete: false,
        up_arrow: false,
        down_arrow: false,
        left_arrow: false,
        right_arrow: false,
        home: false,
        end: false,
        paste: false,
        page_up,
        page_down: !page_up,
    }
}

fn key_event_to_message(key: KeyEvent) -> Option<TuiEvent> {
    if key.kind != KeyEventKind::Press {
        return None;
    }
    let back_tab = key.code == KeyCode::BackTab;
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let meta = key.modifiers.contains(KeyModifiers::META)
        || key.modifiers.contains(KeyModifiers::ALT);
    let shift = key.modifiers.contains(KeyModifiers::SHIFT) || back_tab;
    let input = match key.code {
        KeyCode::Char(ch) => ch.to_string(),
        _ => String::new(),
    };
    Some(TuiEvent::Key {
        input,
        ctrl,
        meta,
        shift,
        escape: key.code == KeyCode::Esc,
        return_key: matches!(
            key.code,
            KeyCode::Enter | KeyCode::Char('\r') | KeyCode::Char('\n')
        ),
        tab: matches!(key.code, KeyCode::Tab | KeyCode::BackTab),
        backspace: key.code == KeyCode::Backspace,
        delete: key.code == KeyCode::Delete,
        up_arrow: key.code == KeyCode::Up,
        down_arrow: key.code == KeyCode::Down,
        left_arrow: key.code == KeyCode::Left,
        right_arrow: key.code == KeyCode::Right,
        home: key.code == KeyCode::Home,
        end: key.code == KeyCode::End,
        paste: false,
        page_up: key.code == KeyCode::PageUp,
        page_down: key.code == KeyCode::PageDown,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scroll_flags(event: &TuiEvent) -> (bool, bool) {
        match event {
            TuiEvent::Key {
                page_up, page_down, ..
            } => (*page_up, *page_down),
            _ => panic!("expected a Key event"),
        }
    }

    // Keyboard scroll remains supported even though mouse selection now uses capture.
    #[test]
    fn page_up_key_maps_to_scroll() {
        let event = key_event_to_message(KeyEvent::new(KeyCode::PageUp, KeyModifiers::NONE))
            .expect("PageUp should produce an event");
        assert_eq!(scroll_flags(&event), (true, false));
    }

    #[test]
    fn page_down_key_maps_to_scroll() {
        let event = key_event_to_message(KeyEvent::new(KeyCode::PageDown, KeyModifiers::NONE))
            .expect("PageDown should produce an event");
        assert_eq!(scroll_flags(&event), (false, true));
    }

    #[test]
    fn non_press_events_are_ignored() {
        let release =
            KeyEvent::new_with_kind(KeyCode::PageUp, KeyModifiers::NONE, KeyEventKind::Release);
        assert!(key_event_to_message(release).is_none());
    }

    fn transcript(lines: &[&str]) -> RenderedTranscript {
        transcript_at(0, lines)
    }

    /// A transcript window whose first row is line `first_row` of the parent's
    /// transcript — what scrolling changes from one frame to the next.
    fn transcript_at(first_row: i64, lines: &[&str]) -> RenderedTranscript {
        let width = lines
            .iter()
            .map(|line| line.chars().count())
            .max()
            .unwrap_or(20)
            .max(20) as u16;
        RenderedTranscript {
            rect: ratatui::layout::Rect::new(0, 0, width, lines.len() as u16),
            first_row,
            lines: lines.iter().map(|line| line.to_string()).collect(),
            links: Vec::new(),
        }
    }

    fn surface(lines: &[&str]) -> RenderedTranscript {
        RenderedTranscript {
            rect: ratatui::layout::Rect::new(0, 0, 80, lines.len() as u16),
            first_row: 0,
            lines: lines.iter().map(|line| line.to_string()).collect(),
            links: Vec::new(),
        }
    }

    fn mouse(kind: MouseEventKind, column: u16, row: u16) -> MouseEvent {
        MouseEvent {
            kind,
            column,
            row,
            modifiers: KeyModifiers::NONE,
        }
    }

    #[test]
    fn drag_scroll_capture_preserves_rows_that_leave_the_viewport() {
        let visible = transcript(&["alpha", "bravo", "charlie", "delta"]);
        let mut selection = MouseSelection::default();
        selection.start(SelectionPoint { row: 3, col: 4 }, 3, true);
        selection.drag_to(SelectionPoint { row: 0, col: 0 }, -1);
        selection.capture_for_scroll(&visible, 1);

        // One line older: the window now starts one row earlier, "delta" left
        // the bottom, and the drag kept growing into the revealed row.
        let shifted = transcript_at(-1, &["zero", "alpha", "bravo", "charlie"]);
        assert_eq!(
            selection.selected_text(&shifted),
            "zero\nalpha\nbravo\ncharlie\ndelta"
        );
    }

    #[test]
    fn selection_stays_on_its_text_when_the_transcript_scrolls() {
        // The window shows lines 10..13 of the transcript; select "charlie".
        let visible = transcript_at(10, &["alpha", "bravo", "charlie", "delta"]);
        let mut selection = MouseSelection::default();
        let point = clamp_point_to_transcript(&visible, 0, 2);
        selection.select_row_at(&visible, point, 2, true);
        assert_eq!(selection.selected_text(&visible), "charlie");

        // Scroll two lines toward older text. The same words are two rows lower
        // on screen, and the selection is still on them — not on whatever the
        // original screen rows now hold.
        let scrolled = transcript_at(8, &["eight", "nine", "alpha", "bravo"]);
        let overlay = selection.overlay().expect("selection should still exist");
        assert!(overlay.anchored_to_transcript);
        assert_eq!(scrolled.screen_row(overlay.start.row), None);
        assert_eq!(selection.selected_text(&scrolled), "");

        // Scroll back and the highlight lands on "charlie" again.
        let restored = transcript_at(10, &["alpha", "bravo", "charlie", "delta"]);
        assert_eq!(restored.screen_row(overlay.start.row), Some(2));
        assert_eq!(selection.selected_text(&restored), "charlie");
    }

    #[test]
    fn transcript_click_records_content_rows_not_screen_rows() {
        let visible = transcript_at(42, &["alpha", "bravo"]);
        let snapshot = RenderSnapshot {
            transcript: Some(visible),
            selection_surface: None,
            scrollbar: None,
        };
        let frame = TuiFrame {
            cols: 20,
            rows: 5,
            gutter: 0,
            content_width: 20,
            spinner_frame: 0,
            transcript_scroll_limit: 42,
            transcript_scroll_offset: 0,
            sections: Vec::new(),
        };
        let mut selection = MouseSelection::default();
        let mut click_state = MouseClickState::default();
        let mut scrollbar_drag = ScrollbarDrag::default();
        let now = Instant::now();
        for (kind, column) in [
            (MouseEventKind::Down(MouseButton::Left), 0),
            (MouseEventKind::Drag(MouseButton::Left), 4),
        ] {
            mouse_event_to_messages(
                &mut selection,
                &mut click_state,
                &mut scrollbar_drag,
                &snapshot,
                Some(&frame),
                mouse(kind, column, 1),
                now,
            );
        }
        let overlay = selection.overlay().expect("drag should select");
        assert_eq!(overlay.start.row, 43, "screen row 1 is transcript line 43");
        assert!(overlay.anchored_to_transcript);
    }

    #[test]
    fn a_rewrap_clears_the_selection_but_a_height_change_does_not() {
        let snapshot = |width: u16, height: u16| RenderSnapshot {
            transcript: Some(RenderedTranscript {
                rect: ratatui::layout::Rect::new(0, 0, width, height),
                first_row: 0,
                lines: vec!["alpha".to_string()],
                links: Vec::new(),
            }),
            selection_surface: None,
            scrollbar: None,
        };

        // Two columns lost to the scrollbar rewraps every line.
        assert!(transcript_rewrapped(&snapshot(80, 20), &snapshot(78, 20)));
        // A taller viewport does not; the scroll limit absorbs it.
        assert!(!transcript_rewrapped(&snapshot(80, 20), &snapshot(80, 30)));
        assert!(!transcript_rewrapped(
            &RenderSnapshot::default(),
            &snapshot(80, 20)
        ));
    }

    #[test]
    fn footer_selection_keeps_screen_rows() {
        let visible = surface(&["transcript row", "you> draft", "TheGitAI • ~/repo"]);
        let snapshot = RenderSnapshot {
            transcript: None,
            selection_surface: Some(visible),
            scrollbar: None,
        };
        let frame = TuiFrame {
            cols: 80,
            rows: 3,
            gutter: 0,
            content_width: 80,
            spinner_frame: 0,
            transcript_scroll_limit: 30,
            transcript_scroll_offset: 4,
            sections: Vec::new(),
        };
        let mut selection = MouseSelection::default();
        let mut click_state = MouseClickState::default();
        let mut scrollbar_drag = ScrollbarDrag::default();
        let now = Instant::now();
        for (kind, column) in [
            (MouseEventKind::Down(MouseButton::Left), 0),
            (MouseEventKind::Drag(MouseButton::Left), 7),
        ] {
            mouse_event_to_messages(
                &mut selection,
                &mut click_state,
                &mut scrollbar_drag,
                &snapshot,
                Some(&frame),
                mouse(kind, column, 2),
                now,
            );
        }
        let overlay = selection.overlay().expect("drag should select");
        // Pinned rows do not scroll, so they stay in screen rows however far
        // the transcript above them has been scrolled.
        assert!(!overlay.anchored_to_transcript);
        assert_eq!(overlay.start.row, 2);
    }

    #[test]
    fn copy_after_scrolling_away_returns_the_text_that_was_selected() {
        let visible = transcript_at(10, &["alpha", "bravo"]);
        let snapshot = RenderSnapshot {
            transcript: Some(visible),
            selection_surface: None,
            scrollbar: None,
        };
        let frame = TuiFrame {
            cols: 20,
            rows: 5,
            gutter: 0,
            content_width: 20,
            spinner_frame: 0,
            transcript_scroll_limit: 10,
            transcript_scroll_offset: 0,
            sections: Vec::new(),
        };
        let mut selection = MouseSelection::default();
        let mut click_state = MouseClickState::default();
        let mut scrollbar_drag = ScrollbarDrag::default();
        let now = Instant::now();
        for (kind, column, row) in [
            (MouseEventKind::Down(MouseButton::Left), 0, 0),
            (MouseEventKind::Drag(MouseButton::Left), 4, 0),
            (MouseEventKind::Up(MouseButton::Left), 4, 0),
        ] {
            mouse_event_to_messages(
                &mut selection,
                &mut click_state,
                &mut scrollbar_drag,
                &snapshot,
                Some(&frame),
                mouse(kind, column, row),
                now,
            );
        }

        // The selected rows have scrolled out of the window, so the surface
        // cannot produce them any more — the copy captured on release can.
        let scrolled = transcript_at(0, &["older-a", "older-b"]);
        assert_eq!(selection.copy_text(&scrolled).as_deref(), Some("alpha"));
    }

    #[test]
    fn drag_scroll_starts_on_viewport_edge_rows() {
        let visible = transcript(&["alpha", "bravo", "charlie"]);
        let frame = TuiFrame {
            cols: 20,
            rows: 5,
            gutter: 0,
            content_width: 20,
            spinner_frame: 0,
            transcript_scroll_limit: 5,
            transcript_scroll_offset: 2,
            sections: Vec::new(),
        };
        let mut selection = MouseSelection::default();
        selection.start(SelectionPoint { row: 2, col: 0 }, 2, true);
        selection.drag_to(SelectionPoint { row: 0, col: 0 }, 0);
        assert_eq!(drag_scroll_delta(&selection, &visible, &frame), 1);

        selection.drag_to(SelectionPoint { row: 2, col: 0 }, 2);
        assert_eq!(drag_scroll_delta(&selection, &visible, &frame), -1);

        selection.start(SelectionPoint { row: 0, col: 0 }, 0, true);
        selection.drag_to(SelectionPoint { row: 0, col: 0 }, 0);
        assert_eq!(drag_scroll_delta(&selection, &visible, &frame), 1);
    }

    #[test]
    fn mouse_release_sends_selection_copy_event() {
        let visible = transcript(&["alpha", "bravo"]);
        let snapshot = RenderSnapshot {
            transcript: Some(visible),
            selection_surface: None,
            scrollbar: None,
        };
        let frame = TuiFrame {
            cols: 20,
            rows: 5,
            gutter: 0,
            content_width: 20,
            spinner_frame: 0,
            transcript_scroll_limit: 0,
            transcript_scroll_offset: 0,
            sections: Vec::new(),
        };
        let mut selection = MouseSelection::default();
        let mut click_state = MouseClickState::default();
        let mut scrollbar_drag = ScrollbarDrag::default();
        let now = Instant::now();
        let messages = mouse_event_to_messages(
            &mut selection,
            &mut click_state,
            &mut scrollbar_drag,
            &snapshot,
            Some(&frame),
            mouse(MouseEventKind::Down(MouseButton::Left), 0, 0),
            now,
        );
        assert!(messages.is_empty());
        let messages = mouse_event_to_messages(
            &mut selection,
            &mut click_state,
            &mut scrollbar_drag,
            &snapshot,
            Some(&frame),
            mouse(MouseEventKind::Drag(MouseButton::Left), 2, 1),
            now,
        );
        assert!(messages.is_empty());
        let messages = mouse_event_to_messages(
            &mut selection,
            &mut click_state,
            &mut scrollbar_drag,
            &snapshot,
            Some(&frame),
            mouse(MouseEventKind::Up(MouseButton::Left), 2, 1),
            now,
        );
        assert!(matches!(
            messages.first(),
            Some(TuiEvent::SelectionCopy { text }) if text == "alpha\nbra"
        ));
    }

    #[test]
    fn plain_left_click_does_not_copy_a_single_character() {
        let visible = transcript(&["alpha"]);
        let snapshot = RenderSnapshot {
            transcript: Some(visible),
            selection_surface: None,
            scrollbar: None,
        };
        let frame = TuiFrame {
            cols: 20,
            rows: 5,
            gutter: 0,
            content_width: 20,
            spinner_frame: 0,
            transcript_scroll_limit: 0,
            transcript_scroll_offset: 0,
            sections: Vec::new(),
        };
        let mut selection = MouseSelection::default();
        let mut click_state = MouseClickState::default();
        let mut scrollbar_drag = ScrollbarDrag::default();
        let now = Instant::now();
        assert!(mouse_event_to_messages(
            &mut selection,
            &mut click_state,
            &mut scrollbar_drag,
            &snapshot,
            Some(&frame),
            mouse(MouseEventKind::Down(MouseButton::Left), 0, 0),
            now,
        )
        .is_empty());
        assert!(mouse_event_to_messages(
            &mut selection,
            &mut click_state,
            &mut scrollbar_drag,
            &snapshot,
            Some(&frame),
            mouse(MouseEventKind::Up(MouseButton::Left), 0, 0),
            now,
        )
        .is_empty());
        assert!(selection.overlay().is_none());

        let later = now + MULTI_CLICK_TIMEOUT + Duration::from_millis(1);
        assert!(mouse_event_to_messages(
            &mut selection,
            &mut click_state,
            &mut scrollbar_drag,
            &snapshot,
            Some(&frame),
            mouse(MouseEventKind::Down(MouseButton::Left), 0, 0),
            later,
        )
        .is_empty());
        assert!(mouse_event_to_messages(
            &mut selection,
            &mut click_state,
            &mut scrollbar_drag,
            &snapshot,
            Some(&frame),
            mouse(MouseEventKind::Drag(MouseButton::Left), 1, 0),
            later,
        )
        .is_empty());
        assert!(selection.overlay().is_none());
        assert!(mouse_event_to_messages(
            &mut selection,
            &mut click_state,
            &mut scrollbar_drag,
            &snapshot,
            Some(&frame),
            mouse(MouseEventKind::Up(MouseButton::Left), 1, 0),
            later,
        )
        .is_empty());
        assert!(selection.overlay().is_none());
    }

    #[test]
    fn url_at_column_detects_visible_markdown_links() {
        let line = "open [https://www.semrush.com](https://www.semrush.com) now";
        let first_url_col = line.find("https://www.semrush.com").unwrap() + 3;
        let second_url_col = line.rfind("https://www.semrush.com").unwrap() + 3;
        assert_eq!(
            url_at_column(line, first_url_col).as_deref(),
            Some("https://www.semrush.com")
        );
        assert_eq!(
            url_at_column(line, second_url_col).as_deref(),
            Some("https://www.semrush.com")
        );
        assert_eq!(url_at_column(line, line.find(']').unwrap()), None);
    }

    #[test]
    fn url_at_point_uses_link_span_metadata_for_labeled_links() {
        let visible = RenderedTranscript {
            rect: ratatui::layout::Rect::new(0, 0, 40, 1),
            first_row: 0,
            lines: vec!["open SEMrush now".to_string()],
            links: vec![RenderedLink {
                row: 0,
                start_col: 5,
                end_col: 11,
                url: "https://www.semrush.com".to_string(),
            }],
        };

        assert_eq!(
            url_at_point(&visible, 8, 0).as_deref(),
            Some("https://www.semrush.com")
        );
    }

    #[test]
    fn left_click_on_link_opens_and_right_click_on_link_copies() {
        let line = "open [https://www.semrush.com](https://www.semrush.com)";
        let link_column = line.find("https://www.semrush.com").unwrap() as u16 + 2;
        let visible = transcript(&[line]);
        let snapshot = RenderSnapshot {
            transcript: Some(visible),
            selection_surface: None,
            scrollbar: None,
        };
        let frame = TuiFrame {
            cols: 80,
            rows: 5,
            gutter: 0,
            content_width: 80,
            spinner_frame: 0,
            transcript_scroll_limit: 0,
            transcript_scroll_offset: 0,
            sections: Vec::new(),
        };
        let mut selection = MouseSelection::default();
        let mut click_state = MouseClickState::default();
        let mut scrollbar_drag = ScrollbarDrag::default();
        let now = Instant::now();
        assert!(mouse_event_to_messages(
            &mut selection,
            &mut click_state,
            &mut scrollbar_drag,
            &snapshot,
            Some(&frame),
            mouse(MouseEventKind::Down(MouseButton::Left), link_column, 0),
            now,
        )
        .is_empty());
        let messages = mouse_event_to_messages(
            &mut selection,
            &mut click_state,
            &mut scrollbar_drag,
            &snapshot,
            Some(&frame),
            mouse(MouseEventKind::Up(MouseButton::Left), link_column, 0),
            now,
        );
        assert!(messages.is_empty());
        assert!(matches!(
            click_state.take_due_link_open(now + MULTI_CLICK_TIMEOUT),
            Some(TuiEvent::LinkOpen { url }) if url == "https://www.semrush.com"
        ));

        let messages = mouse_event_to_messages(
            &mut selection,
            &mut click_state,
            &mut scrollbar_drag,
            &snapshot,
            Some(&frame),
            mouse(MouseEventKind::Down(MouseButton::Right), link_column, 0),
            now,
        );
        assert!(matches!(
            messages.first(),
            Some(TuiEvent::LinkCopy { url }) if url == "https://www.semrush.com"
        ));
    }

    #[test]
    fn double_click_link_selects_word_and_cancels_pending_open() {
        let line = "https://example.com next";
        let link_column = 3;
        let visible = transcript(&[line]);
        let snapshot = RenderSnapshot {
            transcript: Some(visible),
            selection_surface: None,
            scrollbar: None,
        };
        let frame = TuiFrame {
            cols: 80,
            rows: 5,
            gutter: 0,
            content_width: 80,
            spinner_frame: 0,
            transcript_scroll_limit: 0,
            transcript_scroll_offset: 0,
            sections: Vec::new(),
        };
        let mut selection = MouseSelection::default();
        let mut click_state = MouseClickState::default();
        let mut scrollbar_drag = ScrollbarDrag::default();
        let first_click = Instant::now();
        assert!(mouse_event_to_messages(
            &mut selection,
            &mut click_state,
            &mut scrollbar_drag,
            &snapshot,
            Some(&frame),
            mouse(MouseEventKind::Down(MouseButton::Left), link_column, 0),
            first_click,
        )
        .is_empty());
        assert!(mouse_event_to_messages(
            &mut selection,
            &mut click_state,
            &mut scrollbar_drag,
            &snapshot,
            Some(&frame),
            mouse(MouseEventKind::Up(MouseButton::Left), link_column, 0),
            first_click,
        )
        .is_empty());

        let second_click = first_click + Duration::from_millis(100);
        assert!(mouse_event_to_messages(
            &mut selection,
            &mut click_state,
            &mut scrollbar_drag,
            &snapshot,
            Some(&frame),
            mouse(MouseEventKind::Down(MouseButton::Left), link_column, 0),
            second_click,
        )
        .is_empty());
        let second_up = mouse_event_to_messages(
            &mut selection,
            &mut click_state,
            &mut scrollbar_drag,
            &snapshot,
            Some(&frame),
            mouse(MouseEventKind::Up(MouseButton::Left), link_column, 0),
            second_click,
        );
        // Double-click selects the word (not opens the link) and copies it on
        // release, just like a drag selection.
        assert!(matches!(
            second_up.first(),
            Some(TuiEvent::SelectionCopy { text }) if text == "https://example.com"
        ));

        let transcript = snapshot.transcript.as_ref().unwrap();
        assert_eq!(
            selection.copy_text(transcript).as_deref(),
            Some("https://example.com")
        );
        assert!(click_state
            .take_due_link_open(first_click + MULTI_CLICK_TIMEOUT + Duration::from_millis(1))
            .is_none());
    }

    #[test]
    fn triple_click_selects_the_whole_row() {
        let line = "alpha bravo charlie";
        let visible = transcript(&[line]);
        let snapshot = RenderSnapshot {
            transcript: Some(visible),
            selection_surface: None,
            scrollbar: None,
        };
        let frame = TuiFrame {
            cols: 80,
            rows: 5,
            gutter: 0,
            content_width: 80,
            spinner_frame: 0,
            transcript_scroll_limit: 0,
            transcript_scroll_offset: 0,
            sections: Vec::new(),
        };
        let mut selection = MouseSelection::default();
        let mut click_state = MouseClickState::default();
        let mut scrollbar_drag = ScrollbarDrag::default();
        let start = Instant::now();
        let mut last_up = Vec::new();
        for offset in [0, 100, 200] {
            let at = start + Duration::from_millis(offset);
            assert!(mouse_event_to_messages(
                &mut selection,
                &mut click_state,
                &mut scrollbar_drag,
                &snapshot,
                Some(&frame),
                mouse(MouseEventKind::Down(MouseButton::Left), 8, 0),
                at,
            )
            .is_empty());
            last_up = mouse_event_to_messages(
                &mut selection,
                &mut click_state,
                &mut scrollbar_drag,
                &snapshot,
                Some(&frame),
                mouse(MouseEventKind::Up(MouseButton::Left), 8, 0),
                at,
            );
        }

        // The third (triple) click selects the whole row and copies it on release.
        assert!(matches!(
            last_up.first(),
            Some(TuiEvent::SelectionCopy { text }) if text == line
        ));
        let transcript = snapshot.transcript.as_ref().unwrap();
        assert_eq!(selection.copy_text(transcript).as_deref(), Some(line));
    }

    #[test]
    fn double_click_word_copies_on_release() {
        let visible = transcript(&["alpha bravo charlie"]);
        let snapshot = RenderSnapshot {
            transcript: Some(visible),
            selection_surface: None,
            scrollbar: None,
        };
        let frame = TuiFrame {
            cols: 80,
            rows: 5,
            gutter: 0,
            content_width: 80,
            spinner_frame: 0,
            transcript_scroll_limit: 0,
            transcript_scroll_offset: 0,
            sections: Vec::new(),
        };
        let mut selection = MouseSelection::default();
        let mut click_state = MouseClickState::default();
        let mut scrollbar_drag = ScrollbarDrag::default();
        let first = Instant::now();
        // A plain single click never copies on release.
        assert!(mouse_event_to_messages(
            &mut selection,
            &mut click_state,
            &mut scrollbar_drag,
            &snapshot,
            Some(&frame),
            mouse(MouseEventKind::Down(MouseButton::Left), 8, 0),
            first,
        )
        .is_empty());
        assert!(mouse_event_to_messages(
            &mut selection,
            &mut click_state,
            &mut scrollbar_drag,
            &snapshot,
            Some(&frame),
            mouse(MouseEventKind::Up(MouseButton::Left), 8, 0),
            first,
        )
        .is_empty());

        // The double-click selects the word under the cursor and copies it on
        // release without needing a right-click.
        let second = first + Duration::from_millis(100);
        assert!(mouse_event_to_messages(
            &mut selection,
            &mut click_state,
            &mut scrollbar_drag,
            &snapshot,
            Some(&frame),
            mouse(MouseEventKind::Down(MouseButton::Left), 8, 0),
            second,
        )
        .is_empty());
        let up = mouse_event_to_messages(
            &mut selection,
            &mut click_state,
            &mut scrollbar_drag,
            &snapshot,
            Some(&frame),
            mouse(MouseEventKind::Up(MouseButton::Left), 8, 0),
            second,
        );
        assert!(matches!(
            up.first(),
            Some(TuiEvent::SelectionCopy { text }) if text == "bravo"
        ));
    }

    #[test]
    fn right_click_selection_copies_and_footer_opens_context_menu() {
        let visible = transcript(&["alpha", "bravo"]);
        let snapshot = RenderSnapshot {
            transcript: Some(visible),
            selection_surface: None,
            scrollbar: None,
        };
        let frame = TuiFrame {
            cols: 20,
            rows: 5,
            gutter: 0,
            content_width: 20,
            spinner_frame: 0,
            transcript_scroll_limit: 0,
            transcript_scroll_offset: 0,
            sections: Vec::new(),
        };
        let mut selection = MouseSelection::default();
        let mut click_state = MouseClickState::default();
        let mut scrollbar_drag = ScrollbarDrag::default();
        let now = Instant::now();
        selection.start(SelectionPoint { row: 0, col: 0 }, 0, true);
        selection.drag_to(SelectionPoint { row: 0, col: 4 }, 0);
        let messages = mouse_event_to_messages(
            &mut selection,
            &mut click_state,
            &mut scrollbar_drag,
            &snapshot,
            Some(&frame),
            mouse(MouseEventKind::Down(MouseButton::Right), 10, 4),
            now,
        );
        assert!(matches!(
            messages.first(),
            Some(TuiEvent::SelectionCopy { text }) if text == "alpha"
        ));

        selection.clear();
        let messages = mouse_event_to_messages(
            &mut selection,
            &mut click_state,
            &mut scrollbar_drag,
            &snapshot,
            Some(&frame),
            mouse(MouseEventKind::Down(MouseButton::Right), 10, 4),
            now,
        );
        assert!(matches!(messages.first(), Some(TuiEvent::ContextMenu)));
    }

    #[test]
    fn footer_drag_selection_copies_from_selection_surface() {
        let visible = surface(&[
            "transcript row",
            "",
            "you> draft",
            "TheGitAI • ~/repo",
            "Enter sends",
        ]);
        let snapshot = RenderSnapshot {
            transcript: None,
            selection_surface: Some(visible),
            scrollbar: None,
        };
        let frame = TuiFrame {
            cols: 80,
            rows: 5,
            gutter: 0,
            content_width: 80,
            spinner_frame: 0,
            transcript_scroll_limit: 0,
            transcript_scroll_offset: 0,
            sections: Vec::new(),
        };
        let mut selection = MouseSelection::default();
        let mut click_state = MouseClickState::default();
        let mut scrollbar_drag = ScrollbarDrag::default();
        let now = Instant::now();
        assert!(mouse_event_to_messages(
            &mut selection,
            &mut click_state,
            &mut scrollbar_drag,
            &snapshot,
            Some(&frame),
            mouse(MouseEventKind::Down(MouseButton::Left), 0, 3),
            now,
        )
        .is_empty());
        assert!(mouse_event_to_messages(
            &mut selection,
            &mut click_state,
            &mut scrollbar_drag,
            &snapshot,
            Some(&frame),
            mouse(MouseEventKind::Drag(MouseButton::Left), 7, 3),
            now,
        )
        .is_empty());
        let messages = mouse_event_to_messages(
            &mut selection,
            &mut click_state,
            &mut scrollbar_drag,
            &snapshot,
            Some(&frame),
            mouse(MouseEventKind::Up(MouseButton::Left), 7, 3),
            now,
        );
        assert!(matches!(
            messages.first(),
            Some(TuiEvent::SelectionCopy { text }) if text == "TheGitAI"
        ));
    }

    #[test]
    fn scrollbar_drag_emits_absolute_scroll_offsets() {
        let visible = surface(&["row-a", "row-b", "row-c", "row-d"]);
        let hit = ScrollbarHitTarget {
            col: 19,
            y: 0,
            height: 20,
            limit: 40,
        };
        let snapshot = RenderSnapshot {
            transcript: Some(visible.clone()),
            selection_surface: Some(visible),
            scrollbar: Some(hit),
        };
        let frame = TuiFrame {
            cols: 20,
            rows: 20,
            gutter: 0,
            content_width: 20,
            spinner_frame: 0,
            transcript_scroll_limit: 40,
            transcript_scroll_offset: 0,
            sections: Vec::new(),
        };
        let mut selection = MouseSelection::default();
        let mut click_state = MouseClickState::default();
        let mut scrollbar_drag = ScrollbarDrag::default();
        let now = Instant::now();

        let down = mouse_event_to_messages(
            &mut selection,
            &mut click_state,
            &mut scrollbar_drag,
            &snapshot,
            Some(&frame),
            mouse(MouseEventKind::Down(MouseButton::Left), 19, 0),
            now,
        );
        assert!(matches!(
            down.first(),
            Some(TuiEvent::TranscriptScrollTo { offset: 40 })
        ));
        assert!(!selection.dragging);

        let drag = mouse_event_to_messages(
            &mut selection,
            &mut click_state,
            &mut scrollbar_drag,
            &snapshot,
            Some(&frame),
            mouse(MouseEventKind::Drag(MouseButton::Left), 19, 19),
            now,
        );
        assert!(matches!(
            drag.first(),
            Some(TuiEvent::TranscriptScrollTo { offset: 0 })
        ));

        assert!(mouse_event_to_messages(
            &mut selection,
            &mut click_state,
            &mut scrollbar_drag,
            &snapshot,
            Some(&frame),
            mouse(MouseEventKind::Up(MouseButton::Left), 19, 19),
            now,
        )
        .is_empty());
        assert!(!scrollbar_drag.active);
    }
}
