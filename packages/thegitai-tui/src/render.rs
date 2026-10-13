use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Widget, Wrap};
use ratatui::Frame;

use crate::protocol::{TuiSection, TuiSpan};
use crate::text::normalize_line;

const PINNED_BOTTOM_ORDER: &[&str] = &["overlay", "composer", "busyFooter", "live"];

const TRANSCRIPT_SCROLLBAR_THUMB_ROWS: u16 = 6;









const TRANSCRIPT_SCROLLBAR_RESERVED_COLS: u16 = 2;
const TRANSCRIPT_SCROLLBAR_THUMB: &str = "█";
const TRANSCRIPT_SCROLLBAR_COLOR: Color = Color::Rgb(0xd3, 0xd3, 0xd3);

const TRANSCRIPT_SCROLLBAR_HOT_COLOR: Color = Color::Rgb(0xbe, 0xbe, 0xbe);
const TRANSCRIPT_SCROLLBAR_STYLE: Style = Style::new().fg(TRANSCRIPT_SCROLLBAR_COLOR);




const COMPOSER_BORDER_STYLE: Style = Style::new().fg(TRANSCRIPT_SCROLLBAR_COLOR);
const TRANSCRIPT_SCROLLBAR_HOT_STYLE: Style = Style::new().fg(TRANSCRIPT_SCROLLBAR_HOT_COLOR);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TranscriptScroll {
    pub offset: usize,
    pub limit: usize,
    pub hot: bool,
}

impl TranscriptScroll {
    pub fn is_scrollable(self) -> bool {
        self.limit > 0
    }










pub fn first_line(self) -> i64 {
        self.limit as i64 - self.offset as i64
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScrollbarHitTarget {
    pub col: u16,
    pub y: u16,
    pub height: u16,
    pub limit: usize,
}

impl ScrollbarHitTarget {
    pub fn contains(self, column: u16, row: u16) -> bool {
        column == self.col
            && row >= self.y
            && row < self.y.saturating_add(self.height)
    }
}

#[derive(Clone, Debug, Default)]
pub struct RenderSnapshot {
    pub transcript: Option<RenderedTranscript>,
    pub selection_surface: Option<RenderedTranscript>,
    pub scrollbar: Option<ScrollbarHitTarget>,
}

#[derive(Clone, Debug)]
pub struct RenderedTranscript {
    pub rect: Rect,







pub first_row: i64,
    pub lines: Vec<String>,
    pub links: Vec<RenderedLink>,
}

impl RenderedTranscript {


pub fn content_row(&self, screen_row: u16) -> i64 {
        i64::from(screen_row) - i64::from(self.rect.y) + self.first_row
    }



pub fn screen_row(&self, content_row: i64) -> Option<u16> {
        let row = content_row - self.first_row + i64::from(self.rect.y);
        if row < i64::from(self.rect.y) || row >= i64::from(self.rect.bottom()) {
            return None;
        }
        u16::try_from(row).ok()
    }

    pub fn line_at(&self, content_row: i64) -> Option<&str> {
        let index = usize::try_from(content_row - self.first_row).ok()?;
        self.lines.get(index).map(String::as_str)
    }



pub fn last_row(&self) -> i64 {
        self.first_row + self.lines.len().saturating_sub(1) as i64
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RenderedLink {
    pub row: u16,
    pub start_col: u16,
    pub end_col: u16,
    pub url: String,
}




#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SelectionPoint {
    pub row: i64,
    pub col: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SelectionOverlay {
    pub start: SelectionPoint,
    pub end: SelectionPoint,


pub anchored_to_transcript: bool,
}

pub fn render_sections(
    frame: &mut Frame,
    sections: &[TuiSection],
    area: Rect,
    selection: Option<SelectionOverlay>,
    transcript_scroll: TranscriptScroll,
) -> RenderSnapshot {
    let sections: Vec<TuiSection> = sections
        .iter()
        .map(|section| TuiSection {
            kind: section.kind.clone(),
            lines: section.lines.iter().map(normalize_line).collect(),
        })
        .collect();
    let mut transcript: Option<&TuiSection> = None;
    let mut pinned: Vec<&TuiSection> = Vec::new();
    let mut snapshot = RenderSnapshot::default();
    let mut surface_lines = vec![String::new(); usize::from(area.height)];
    let mut surface_links = Vec::new();

    for section in &sections {
        if section.kind == "transcript" {
            transcript = Some(section);
        } else if PINNED_BOTTOM_ORDER.contains(&section.kind.as_str()) {
            pinned.push(section);
        }
    }

    let mut bottom = area.bottom();
    for kind in PINNED_BOTTOM_ORDER {
        let Some(section) = pinned.iter().find(|section| section.kind == *kind) else {
            continue;
        };



        let height = section_height(section, area.width).min(bottom);
        if height == 0 {
            continue;
        }
        bottom -= height;
        let section_area = Rect {
            x: area.x,
            y: bottom,
            width: area.width,
            height,
        };
        render_section(frame, section, section_area);
        let (text_area, lines, links) =
            rendered_section_text(section, section_area, frame.buffer_mut());
        merge_surface(
            area,
            &mut surface_lines,
            &mut surface_links,
            text_area,
            &lines,
            links,
        );
    }

    if let Some(section) = transcript {
        let height = bottom.saturating_sub(area.y);
        if height == 0 {
            return snapshot;
        }
        let section_area = Rect {
            x: area.x,
            y: area.y,
            width: area.width,
            height,
        };
        let (rendered, scrollbar) =
            render_transcript_section(frame, section, section_area, transcript_scroll);
        merge_surface(
            area,
            &mut surface_lines,
            &mut surface_links,
            rendered.rect,
            &rendered.lines,
            rendered.links.clone(),
        );
        snapshot.transcript = Some(rendered);
        snapshot.scrollbar = scrollbar;
    }

    if area.width > 0 && area.height > 0 {
        let surface = RenderedTranscript {
            rect: area,

            first_row: i64::from(area.y),
            lines: surface_lines,
            links: surface_links,
        };
        if let Some(selection) = selection {




            let target = if selection.anchored_to_transcript {
                snapshot.transcript.as_ref()
            } else {
                Some(&surface)
            };
            if let Some(target) = target {
                apply_selection_overlay(frame, target, selection);
            }
        }
        snapshot.selection_surface = Some(surface);
    }

    snapshot
}

fn section_height(section: &TuiSection, width: u16) -> u16 {
    if section.kind == "composer" {




        let lines: Vec<Line> = section.lines.iter().map(spans_to_line).collect();
        let wrapped = Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .line_count(width)
            .max(1) as u16;
        return wrapped.saturating_add(1);
    }
    section.lines.len().max(1) as u16
}

fn render_transcript_section(
    frame: &mut Frame,
    section: &TuiSection,
    area: Rect,
    scroll: TranscriptScroll,
) -> (RenderedTranscript, Option<ScrollbarHitTarget>) {
    let show_scrollbar =
        scroll.is_scrollable() && area.width > TRANSCRIPT_SCROLLBAR_RESERVED_COLS;
    let text_width = if show_scrollbar {
        area.width.saturating_sub(TRANSCRIPT_SCROLLBAR_RESERVED_COLS)
    } else {
        area.width
    };
    let text_area = Rect {
        x: area.x,
        y: area.y,
        width: text_width,
        height: area.height,
    };
    let mut source_lines = section.lines.clone();
    let max_lines = usize::from(area.height);


    let mut first_row = scroll.first_line();
    if source_lines.len() > max_lines {
        let skip = source_lines.len().saturating_sub(max_lines);
        first_row += skip as i64;
        source_lines = source_lines.split_off(skip);
    }
    let rendered_text = source_lines.iter().map(line_text).collect::<Vec<_>>();
    let mut links = Vec::new();
    for (index, line) in source_lines.iter().enumerate() {
        let row = text_area.y.saturating_add(index as u16);
        links.extend(line_links(line, row, text_width));
    }
    let lines: Vec<Line> = source_lines.iter().map(spans_to_line).collect();
    Clear.render(area, frame.buffer_mut());
    Paragraph::new(lines).render(text_area, frame.buffer_mut());
    let scrollbar = if show_scrollbar {
        Some(paint_transcript_scrollbar(frame.buffer_mut(), area, scroll))
    } else {
        None
    };
    (
        RenderedTranscript {
            rect: text_area,
            first_row,
            lines: rendered_text,
            links,
        },
        scrollbar,
    )
}

pub fn transcript_scrollbar_thumb_height(track_height: u16) -> u16 {
    TRANSCRIPT_SCROLLBAR_THUMB_ROWS.min(track_height).max(1)
}

pub fn transcript_scrollbar_thumb_top(scroll: TranscriptScroll, track_height: u16) -> u16 {
    let thumb_height = transcript_scrollbar_thumb_height(track_height);
    if scroll.limit == 0 || track_height <= thumb_height {
        return 0;
    }
    let travel = u32::from(track_height.saturating_sub(thumb_height));

    let from_top = scroll.limit.saturating_sub(scroll.offset) as u32;
    ((from_top * travel) / scroll.limit as u32) as u16
}



pub fn transcript_scrollbar_offset_for_row(
    limit: usize,
    track_y: u16,
    track_height: u16,
    mouse_row: u16,
) -> usize {
    if limit == 0 || track_height == 0 {
        return 0;
    }
    let thumb_height = transcript_scrollbar_thumb_height(track_height);
    let travel = track_height.saturating_sub(thumb_height);
    if travel == 0 {
        return 0;
    }
    let rel = mouse_row
        .saturating_sub(track_y)
        .min(track_height.saturating_sub(1));

    let desired_top = rel.saturating_sub(thumb_height / 2).min(travel);
    let from_top = u64::from(desired_top);
    let travel = u64::from(travel);
    let limit_u = limit as u64;
    (limit_u - (from_top * limit_u) / travel) as usize
}

fn paint_transcript_scrollbar(
    buffer: &mut Buffer,
    area: Rect,
    scroll: TranscriptScroll,
) -> ScrollbarHitTarget {
    let col = area.right().saturating_sub(1);
    let thumb_height = transcript_scrollbar_thumb_height(area.height);
    let thumb_top = transcript_scrollbar_thumb_top(scroll, area.height);
    let thumb_start = area.y.saturating_add(thumb_top);
    let thumb_end = thumb_start.saturating_add(thumb_height).min(area.bottom());
    let style = if scroll.hot {
        TRANSCRIPT_SCROLLBAR_HOT_STYLE
    } else {
        TRANSCRIPT_SCROLLBAR_STYLE
    };
    for row in thumb_start..thumb_end {
        buffer.set_string(col, row, TRANSCRIPT_SCROLLBAR_THUMB, style);
    }
    ScrollbarHitTarget {
        col,
        y: area.y,
        height: area.height,
        limit: scroll.limit,
    }
}

fn render_section(frame: &mut Frame, section: &TuiSection, area: Rect) {
    let mut lines: Vec<Line> = section.lines.iter().map(spans_to_line).collect();
    let max_lines = usize::from(area.height);
    if lines.len() > max_lines {
        let skip = lines.len().saturating_sub(max_lines);
        lines = lines.split_off(skip);
    }
    let mut paragraph = Paragraph::new(lines);
    if section.kind == "composer" {




        paragraph = paragraph.wrap(Wrap { trim: false }).block(
            Block::default()
                .borders(Borders::TOP)
                .border_style(COMPOSER_BORDER_STYLE),
        );
    }
    Clear.render(area, frame.buffer_mut());
    paragraph.render(area, frame.buffer_mut());
}

fn rendered_section_text(
    section: &TuiSection,
    area: Rect,
    buffer: &Buffer,
) -> (Rect, Vec<String>, Vec<RenderedLink>) {
    let text_area = if section.kind == "composer" {
        Rect {
            x: area.x,
            y: area.y.saturating_add(1),
            width: area.width,
            height: area.height.saturating_sub(1),
        }
    } else {
        area
    };
    if text_area.height == 0 {
        return (text_area, Vec::new(), Vec::new());
    }
    if section.kind == "composer" {
        return (text_area, buffer_lines(buffer, text_area), Vec::new());
    }
    let mut source_lines = section.lines.clone();
    let max_lines = usize::from(text_area.height);
    if source_lines.len() > max_lines {
        let skip = source_lines.len().saturating_sub(max_lines);
        source_lines = source_lines.split_off(skip);
    }
    let rendered_text = source_lines.iter().map(line_text).collect::<Vec<_>>();
    let mut links = Vec::new();
    for (index, line) in source_lines.iter().enumerate() {
        let row = text_area.y.saturating_add(index as u16);
        links.extend(line_links(line, row, text_area.width));
    }
    (text_area, rendered_text, links)
}

fn buffer_lines(buffer: &Buffer, area: Rect) -> Vec<String> {
    (area.y..area.bottom())
        .map(|row| {
            let mut text = String::new();
            for col in area.x..area.right() {
                if let Some(cell) = buffer.cell((col, row)) {
                    text.push_str(cell.symbol());
                }
            }
            text.trim_end_matches(' ').to_string()
        })
        .collect()
}

fn merge_surface(
    area: Rect,
    surface_lines: &mut [String],
    surface_links: &mut Vec<RenderedLink>,
    section_area: Rect,
    lines: &[String],
    links: Vec<RenderedLink>,
) {
    for (index, text) in lines.iter().enumerate() {
        let row = section_area.y.saturating_add(index as u16);
        if row < area.y || row >= area.bottom() {
            continue;
        }
        let surface_index = usize::from(row.saturating_sub(area.y));
        if let Some(line) = surface_lines.get_mut(surface_index) {
            *line = text.clone();
        }
    }
    surface_links.extend(links);
}

fn spans_to_line(line: &crate::protocol::TuiLine) -> Line<'static> {
    Line::from(line.spans.iter().map(span_to_ratatui).collect::<Vec<_>>())
}

fn line_text(line: &crate::protocol::TuiLine) -> String {
    line.spans
        .iter()
        .map(|span| span.text.as_str())
        .collect::<String>()
}

fn line_links(line: &crate::protocol::TuiLine, row: u16, width: u16) -> Vec<RenderedLink> {
    let mut links = Vec::new();
    let mut col: usize = 0;
    let visible_width = usize::from(width);
    for span in &line.spans {
        let len = Span::raw(span.text.as_str()).width();
        if len == 0 {
            continue;
        }
        if let Some(url) = span.link_url.as_ref() {
            let start = col;
            let end = col + len - 1;
            if start < visible_width {
                links.push(RenderedLink {
                    row,
                    start_col: start as u16,
                    end_col: end.min(visible_width.saturating_sub(1)) as u16,
                    url: url.clone(),
                });
            }
        }
        col += len;
    }
    links
}

fn apply_selection_overlay(
    frame: &mut Frame,
    transcript: &RenderedTranscript,
    selection: SelectionOverlay,
) {
    if transcript.rect.width == 0 || transcript.rect.height == 0 || transcript.lines.is_empty() {
        return;
    }
    let style = Style::default().fg(Color::Black).bg(Color::Cyan);
    let start = selection.start;
    let end = selection.end;


    let first = start.row.max(transcript.first_row);
    let last = end.row.min(transcript.last_row());
    if first > last {
        return;
    }
    for content_row in first..=last {
        let Some(row) = transcript.screen_row(content_row) else {
            continue;
        };
        let Some(text) = transcript.line_at(content_row) else {
            continue;
        };
        let visible_len = text
            .chars()
            .count()
            .max(1)
            .min(usize::from(transcript.rect.width));
        let row_start = if content_row == start.row {
            start.col
        } else {
            0
        };
        let row_end = if content_row == end.row {
            end.col
        } else {
            transcript.rect.width.saturating_sub(1)
        };
        let row_start = usize::from(row_start).min(visible_len.saturating_sub(1));
        let row_end = usize::from(row_end).min(visible_len.saturating_sub(1));
        if row_start > row_end {
            continue;
        }
        for col in row_start..=row_end {
            let x = transcript
                .rect
                .x
                .saturating_add(u16::try_from(col).unwrap_or(u16::MAX));
            if let Some(cell) = frame.buffer_mut().cell_mut((x, row)) {
                cell.set_style(style);
            }
        }
    }
}

fn span_to_ratatui(span: &TuiSpan) -> Span<'static> {
    let mut style = Style::default();
    if let Some(color) = map_color(span.color.as_deref()) {
        style = style.fg(color);
    }
    if let Some(color) = map_color(span.bg_color.as_deref()) {
        style = style.bg(color);
    }
    if span.bold {
        style = style.add_modifier(Modifier::BOLD);
    }
    if span.dim {
        style = style.add_modifier(Modifier::DIM);
    }
    if span.inverse {
        style = style.add_modifier(Modifier::REVERSED);
    }
    if span.underline {
        style = style.add_modifier(Modifier::UNDERLINED);
    }
    Span::styled(span.text.clone(), style)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{TuiLine, TuiSpan};
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    fn span(text: &str, inverse: bool) -> TuiSpan {
        TuiSpan {
            text: text.to_string(),
            color: None,
            bg_color: None,
            bold: false,
            dim: false,
            inverse,
            underline: false,
            link_url: None,
        }
    }

    fn is_transcript_scrollbar_thumb_glyph(symbol: &str) -> bool {
        symbol == TRANSCRIPT_SCROLLBAR_THUMB
    }

    #[test]
    fn tabs_render_as_cells_across_styles_on_every_surface() {
        for kind in ["transcript", "live", "busyFooter", "overlay", "composer"] {
            let mut linked = span("result", false);
            linked.link_url = Some("https://example.com/result".to_string());
            linked.bold = true;
            let section = TuiSection {
                kind: kind.to_string(),
                lines: vec![TuiLine {
                    spans: vec![
                        span("wi\u{1b}[31mde\u{1b}[0m界\r\u{8}", false),
                        span("\t", false),
                        linked,
                    ],
                }],
            };
            let mut terminal = Terminal::new(TestBackend::new(32, 8)).unwrap();
            let mut snapshot = RenderSnapshot::default();
            terminal
                .draw(|frame| {
                    snapshot = render_sections(
                        frame,
                        &[section],
                        Rect::new(3, 0, 24, 8),
                        None,
                        TranscriptScroll::default(),
                    );
                })
                .unwrap();
            let buffer = terminal.backend().buffer();
            let row = (0..8)
                .find(|&row| buffer.cell((11, row)).unwrap().symbol() == "r")
                .unwrap_or_else(|| panic!("{kind}: text after tab must start at column 8"));
            assert!(buffer
                .cell((11, row))
                .unwrap()
                .modifier
                .contains(Modifier::BOLD));
            assert!(buffer
                .content()
                .iter()
                .all(|cell| !cell.symbol().chars().any(char::is_control)));
            if kind != "composer" {
                let surface = snapshot.selection_surface.unwrap();
                assert!(surface.lines.iter().any(|text| text == "wide界  result"));
                assert!(surface
                    .links
                    .iter()
                    .any(|link| link.row == row && link.start_col == 8 && link.end_col == 13));
            }
        }
    }

    #[test]
    fn tabbed_live_output_can_disappear_without_terminal_cursor_controls() {
        use ratatui::backend::{Backend, CrosstermBackend};
        let live = TuiSection {
            kind: "live".to_string(),
            lines: (1..=6)
                .map(|index| TuiLine {
                    spans: vec![span(
                        &format!("check-{index}\tpass\t0\thttps://example.com/job/{index:012}\t"),
                        false,
                    )],
                })
                .collect(),
        };
        let mut terminal = Terminal::new(TestBackend::new(96, 12)).unwrap();
        terminal
            .draw(|frame| {
                render_sections(
                    frame,
                    &[live],
                    frame.area(),
                    None,
                    TranscriptScroll::default(),
                );
            })
            .unwrap();
        let mut bytes = Vec::new();
        let buffer = terminal.backend().buffer();
        CrosstermBackend::new(&mut bytes)
            .draw(
                buffer
                    .content()
                    .iter()
                    .enumerate()
                    .map(|(index, cell)| ((index % 96) as u16, (index / 96) as u16, cell)),
            )
            .unwrap();
        assert!(!bytes.contains(&b'\t'), "raw tabs reached the terminal");
        terminal
            .draw(|frame| {
                render_sections(frame, &[], frame.area(), None, TranscriptScroll::default());
            })
            .unwrap();
        assert!(terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .all(|cell| cell.symbol() == " "));
    }

    #[test]
    fn composer_wraps_long_input_so_no_chars_are_clipped() {



        let input = "X".repeat(50);
        let composer = TuiSection {
            kind: "composer".to_string(),
            lines: vec![TuiLine {
                spans: vec![span("you> ", false), span(&input, false)],
            }],
        };
        let width: u16 = 20;
        let backend = TestBackend::new(width, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| {
                render_sections(
                    frame,
                    &[composer],
                    frame.area(),
                    None,
                    TranscriptScroll::default(),
                );
            })
            .unwrap();

        let buffer = terminal.backend().buffer();
        let rendered_x = buffer
            .content()
            .iter()
            .filter(|cell| cell.symbol() == "X")
            .count();
        assert_eq!(
            rendered_x, 50,
            "expected all 50 input chars to be visible (wrapped), saw {rendered_x}"
        );
    }

    #[test]
    fn live_section_uses_prewrapped_line_count_for_height() {
        let live = TuiSection {
            kind: "live".to_string(),
            lines: vec![TuiLine {
                spans: vec![span(&"L".repeat(80), false)],
            }],
        };

        assert_eq!(section_height(&live, 20), 1);
    }

    #[test]
    fn shrinking_live_section_clears_stale_rows() {
        let transcript = TuiSection {
            kind: "transcript".to_string(),
            lines: vec![TuiLine {
                spans: vec![span("System ready", false)],
            }],
        };
        let first_live = TuiSection {
            kind: "live".to_string(),
            lines: vec![
                TuiLine {
                    spans: vec![span("2026 stale one", false)],
                },
                TuiLine {
                    spans: vec![span("2026 stale two", false)],
                },
                TuiLine {
                    spans: vec![span("2026 stale three", false)],
                },
                TuiLine {
                    spans: vec![span("2026 stale four", false)],
                },
            ],
        };
        let second_live = TuiSection {
            kind: "live".to_string(),
            lines: vec![TuiLine {
                spans: vec![span("Working", false)],
            }],
        };
        let backend = TestBackend::new(24, 8);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| {
                render_sections(
                    frame,
                    &[transcript.clone(), first_live],
                    frame.area(),
                    None,
                    TranscriptScroll::default(),
                );
            })
            .unwrap();
        terminal
            .draw(|frame| {
                render_sections(
                    frame,
                    &[transcript, second_live],
                    frame.area(),
                    None,
                    TranscriptScroll::default(),
                );
            })
            .unwrap();

        let buffer = terminal.backend().buffer();
        assert_eq!(buffer.cell((0, 4)).unwrap().symbol(), " ");
        assert_eq!(buffer.cell((0, 5)).unwrap().symbol(), " ");
        assert_eq!(buffer.cell((0, 6)).unwrap().symbol(), " ");
    }

    #[test]
    fn selection_overlay_only_styles_transcript_cells() {
        let transcript = TuiSection {
            kind: "transcript".to_string(),
            lines: vec![
                TuiLine {
                    spans: vec![span("alpha", false)],
                },
                TuiLine {
                    spans: vec![span("bravo", false)],
                },
            ],
        };
        let composer = TuiSection {
            kind: "composer".to_string(),
            lines: vec![TuiLine {
                spans: vec![span("you> draft", false)],
            }],
        };
        let backend = TestBackend::new(20, 6);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| {
                render_sections(
                    frame,
                    &[transcript, composer],
                    frame.area(),
                    Some(SelectionOverlay {
                        start: SelectionPoint { row: 0, col: 1 },
                        end: SelectionPoint { row: 0, col: 3 },
                        anchored_to_transcript: true,
                    }),
                    TranscriptScroll::default(),
                );
            })
            .unwrap();

        let buffer = terminal.backend().buffer();
        assert_eq!(buffer.cell((1, 0)).unwrap().bg, Color::Cyan);
        assert_eq!(buffer.cell((3, 0)).unwrap().bg, Color::Cyan);
        assert_ne!(buffer.cell((0, 0)).unwrap().bg, Color::Cyan);
        assert_ne!(buffer.cell((0, 4)).unwrap().bg, Color::Cyan);
    }

    #[test]
    fn selection_overlay_follows_its_text_when_the_transcript_scrolls() {


        let all: Vec<String> = (0..20).map(|index| format!("row-{index}")).collect();
        let height = 6usize;
        let limit = all.len() - height;
        let window = |offset: usize| TuiSection {
            kind: "transcript".to_string(),
            lines: all[limit - offset..limit - offset + height]
                .iter()
                .map(|text| TuiLine {
                    spans: vec![span(text, false)],
                })
                .collect(),
        };
        let draw = |offset: usize, selection: Option<SelectionOverlay>| {
            let backend = TestBackend::new(20, height as u16);
            let mut terminal = Terminal::new(backend).unwrap();
            let mut snapshot = RenderSnapshot::default();
            terminal
                .draw(|frame| {
                    snapshot = render_sections(
                        frame,
                        &[window(offset)],
                        frame.area(),
                        selection,
                        TranscriptScroll {
                            offset,
                            limit,
                            hot: false,
                        },
                    );
                })
                .unwrap();
            let buffer = terminal.backend().buffer().clone();
            (snapshot, buffer)
        };

        let (snapshot, _) = draw(0, None);
        let transcript = snapshot.transcript.unwrap();
        assert_eq!(transcript.first_row, limit as i64);

        let selected_row = transcript.content_row(1);
        let selection = SelectionOverlay {
            start: SelectionPoint {
                row: selected_row,
                col: 0,
            },
            end: SelectionPoint {
                row: selected_row,
                col: 5,
            },
            anchored_to_transcript: true,
        };
        let (_, buffer) = draw(0, Some(selection));
        let highlighted = |buffer: &Buffer| -> Vec<(u16, String)> {
            (0..height as u16)
                .filter(|&row| buffer.cell((0, row)).unwrap().bg == Color::Cyan)
                .map(|row| {
                    let text: String = (0..6u16)
                        .map(|col| buffer.cell((col, row)).unwrap().symbol().to_string())
                        .collect();
                    (row, text)
                })
                .collect()
        };
        assert_eq!(highlighted(&buffer), vec![(1, "row-15".to_string())]);



        let (_, buffer) = draw(1, Some(selection));
        assert_eq!(highlighted(&buffer), vec![(2, "row-15".to_string())]);



        let (_, buffer) = draw(6, Some(selection));
        assert!(highlighted(&buffer).is_empty());
    }

    #[test]
    fn render_snapshot_tracks_link_span_ranges() {
        let transcript = TuiSection {
            kind: "transcript".to_string(),
            lines: vec![TuiLine {
                spans: vec![
                    span("open ", false),
                    TuiSpan {
                        text: "SEMrush".to_string(),
                        color: Some("cyan".to_string()),
                        bg_color: None,
                        bold: false,
                        dim: false,
                        inverse: false,
                        underline: true,
                        link_url: Some("https://www.semrush.com".to_string()),
                    },
                ],
            }],
        };
        let sections = vec![transcript];
        let backend = TestBackend::new(40, 4);
        let mut terminal = Terminal::new(backend).unwrap();
        let mut snapshot = RenderSnapshot::default();
        terminal
            .draw(|frame| {
                snapshot = render_sections(
                    frame,
                    &sections,
                    frame.area(),
                    None,
                    TranscriptScroll::default(),
                );
            })
            .unwrap();

        let transcript = snapshot.transcript.unwrap();
        assert_eq!(
            transcript.links,
            vec![RenderedLink {
                row: 0,
                start_col: 5,
                end_col: 11,
                url: "https://www.semrush.com".to_string(),
            }]
        );
    }

    #[test]
    fn render_snapshot_tracks_composer_rows_for_selection() {
        let composer = TuiSection {
            kind: "composer".to_string(),
            lines: vec![TuiLine {
                spans: vec![span("you> draft", false)],
            }],
        };
        let backend = TestBackend::new(30, 6);
        let mut terminal = Terminal::new(backend).unwrap();
        let mut snapshot = RenderSnapshot::default();
        terminal
            .draw(|frame| {
                snapshot = render_sections(
                    frame,
                    &[composer],
                    frame.area(),
                    None,
                    TranscriptScroll::default(),
                );
            })
            .unwrap();

        let surface = snapshot.selection_surface.unwrap();
        assert!(surface.lines.iter().any(|text| text == "you> draft"));
    }

    #[test]
    fn render_snapshot_tracks_wrapped_composer_rows_for_selection() {
        let composer = TuiSection {
            kind: "composer".to_string(),
            lines: vec![TuiLine {
                spans: vec![span("you> ", false), span("alpha beta gamma", false)],
            }],
        };
        let backend = TestBackend::new(12, 8);
        let mut terminal = Terminal::new(backend).unwrap();
        let mut snapshot = RenderSnapshot::default();
        terminal
            .draw(|frame| {
                snapshot = render_sections(
                    frame,
                    &[composer],
                    frame.area(),
                    None,
                    TranscriptScroll::default(),
                );
            })
            .unwrap();

        let surface = snapshot.selection_surface.unwrap();
        let visible = surface
            .lines
            .iter()
            .filter(|line| !line.is_empty())
            .cloned()
            .collect::<Vec<_>>();
        assert!(
            visible.len() >= 2,
            "expected wrapped composer rows in selection surface, saw {visible:?}"
        );
        assert!(visible.iter().any(|line| line.contains("alpha")));
        assert!(visible.iter().any(|line| line.contains("gamma")));
    }

    #[test]
    fn scrollable_transcript_reserves_right_column_for_scrollbar() {
        let transcript = TuiSection {
            kind: "transcript".to_string(),
            lines: vec![
                TuiLine {
                    spans: vec![span("line-one", false)],
                },
                TuiLine {
                    spans: vec![span("line-two", false)],
                },
                TuiLine {
                    spans: vec![span("line-three", false)],
                },
            ],
        };
        let backend = TestBackend::new(20, 3);
        let mut terminal = Terminal::new(backend).unwrap();
        let mut snapshot = RenderSnapshot::default();
        terminal
            .draw(|frame| {
                snapshot = render_sections(
                    frame,
                    &[transcript],
                    frame.area(),
                    None,
                    TranscriptScroll {
                        offset: 0,
                        limit: 5,
                        hot: false,
                    },
                );
            })
            .unwrap();

        let rendered = snapshot.transcript.unwrap();
        assert_eq!(
            rendered.rect.width,
            18,
            "text area leaves a gap column plus the scrollbar column"
        );
        let buffer = terminal.backend().buffer();
        let right_col = 19u16;
        let gap_col = 18u16;
        let thumb_cells = (0..3u16)
            .filter(|&row| {
                is_transcript_scrollbar_thumb_glyph(buffer.cell((right_col, row)).unwrap().symbol())
            })
            .count();
        assert_eq!(thumb_cells, 3, "thumb clamps to the short transcript height");
        assert!(
            (0..3u16).all(|row| buffer.cell((right_col, row)).unwrap().symbol()
                == TRANSCRIPT_SCROLLBAR_THUMB),
            "every thumb row is a full block — the ends are square, not capped"
        );
        assert_eq!(
            buffer.cell((right_col, 0)).unwrap().style().fg,
            Some(TRANSCRIPT_SCROLLBAR_COLOR)
        );
        assert!(
            (0..3u16).all(|row| buffer.cell((gap_col, row)).unwrap().symbol() == " "),
            "gap column between text and thumb must stay empty"
        );
        assert_eq!(buffer.cell((0, 0)).unwrap().symbol(), "l");
    }

    #[test]
    fn scrollbar_hot_style_is_about_ten_percent_darker() {
        let transcript = TuiSection {
            kind: "transcript".to_string(),
            lines: (0..8)
                .map(|index| TuiLine {
                    spans: vec![span(&format!("row-{index}"), false)],
                })
                .collect(),
        };
        let backend = TestBackend::new(20, 8);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| {
                render_sections(
                    frame,
                    &[transcript],
                    frame.area(),
                    None,
                    TranscriptScroll {
                        offset: 0,
                        limit: 10,
                        hot: true,
                    },
                );
            })
            .unwrap();
        let cell = terminal.backend().buffer().cell((19, 7)).unwrap();
        assert_eq!(cell.symbol(), TRANSCRIPT_SCROLLBAR_THUMB);
        assert_eq!(cell.style().fg, Some(TRANSCRIPT_SCROLLBAR_HOT_COLOR));
    }

    #[test]
    fn composer_top_rule_matches_the_scrollbar_color() {
        let composer = TuiSection {
            kind: "composer".to_string(),
            lines: vec![TuiLine {
                spans: vec![span("type here", false)],
            }],
        };
        let backend = TestBackend::new(20, 6);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| {
                render_sections(
                    frame,
                    &[composer],
                    frame.area(),
                    None,
                    TranscriptScroll::default(),
                );
            })
            .unwrap();





        let buffer = terminal.backend().buffer();
        let rule_row = (0..6u16)
            .find(|&row| buffer.cell((0, row)).unwrap().symbol() == "─")
            .expect("composer should draw a top rule");
        for col in 0..20u16 {
            let cell = buffer.cell((col, rule_row)).unwrap();
            assert_eq!(cell.symbol(), "─", "rule spans the full width");
            assert_eq!(
                cell.style().fg,
                Some(TRANSCRIPT_SCROLLBAR_COLOR),
                "composer rule must match the scrollbar thumb color"
            );
            assert!(
                !cell.style().add_modifier.contains(Modifier::DIM),
                "dimming would push the rule off the thumb's shade"
            );
        }
    }

    #[test]
    fn scrollbar_has_no_track_and_fixed_light_gray_thumb() {
        let transcript = TuiSection {
            kind: "transcript".to_string(),
            lines: (0..20)
                .map(|index| TuiLine {
                    spans: vec![span(&format!("row-{index}"), false)],
                })
                .collect(),
        };
        let backend = TestBackend::new(20, 20);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| {
                render_sections(
                    frame,
                    &[transcript],
                    frame.area(),
                    None,
                    TranscriptScroll {
                        offset: 0,
                        limit: 40,
                        hot: false,
                    },
                );
            })
            .unwrap();

        let buffer = terminal.backend().buffer();
        let right_col = 19u16;
        let thumb_rows = (0..20u16)
            .filter(|&row| {
                let cell = buffer.cell((right_col, row)).unwrap();
                is_transcript_scrollbar_thumb_glyph(cell.symbol())
                    && cell.style().fg == Some(TRANSCRIPT_SCROLLBAR_COLOR)
            })
            .collect::<Vec<_>>();
        assert_eq!(
            thumb_rows.len(),
            usize::from(TRANSCRIPT_SCROLLBAR_THUMB_ROWS),
            "thumb should be about an inch tall, saw {thumb_rows:?}"
        );
        assert_eq!(*thumb_rows.last().unwrap(), 19);
        assert!(
            thumb_rows.iter().all(|&row| {
                buffer.cell((right_col, row)).unwrap().symbol() == TRANSCRIPT_SCROLLBAR_THUMB
            }),
            "every thumb row is a full block — no half-block end caps"
        );
        let empty_track = (0..20u16)
            .filter(|&row| !thumb_rows.contains(&row))
            .all(|row| buffer.cell((right_col, row)).unwrap().symbol() == " ");
        assert!(empty_track, "scrollbar must not paint a track background");
    }

    #[test]
    fn scrollbar_thumb_sits_at_bottom_when_offset_is_zero() {
        let transcript = TuiSection {
            kind: "transcript".to_string(),
            lines: (0..20)
                .map(|index| TuiLine {
                    spans: vec![span(&format!("row-{index}"), false)],
                })
                .collect(),
        };
        let backend = TestBackend::new(20, 20);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| {
                render_sections(
                    frame,
                    &[transcript],
                    frame.area(),
                    None,
                    TranscriptScroll {
                        offset: 0,
                        limit: 40,
                        hot: false,
                    },
                );
            })
            .unwrap();

        let buffer = terminal.backend().buffer();
        let right_col = 19u16;
        let thumb_rows = (0..20u16)
            .filter(|&row| {
                is_transcript_scrollbar_thumb_glyph(buffer.cell((right_col, row)).unwrap().symbol())
            })
            .collect::<Vec<_>>();
        assert_eq!(*thumb_rows.last().unwrap(), 19);
        assert_eq!(
            thumb_rows.first().copied(),
            Some(20 - TRANSCRIPT_SCROLLBAR_THUMB_ROWS)
        );
    }

    #[test]
    fn scrollbar_thumb_sits_at_top_when_offset_is_limit() {
        let transcript = TuiSection {
            kind: "transcript".to_string(),
            lines: (0..20)
                .map(|index| TuiLine {
                    spans: vec![span(&format!("row-{index}"), false)],
                })
                .collect(),
        };
        let backend = TestBackend::new(20, 20);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| {
                render_sections(
                    frame,
                    &[transcript],
                    frame.area(),
                    None,
                    TranscriptScroll {
                        offset: 40,
                        limit: 40,
                        hot: false,
                    },
                );
            })
            .unwrap();

        let buffer = terminal.backend().buffer();
        let right_col = 19u16;
        let thumb_rows = (0..20u16)
            .filter(|&row| {
                is_transcript_scrollbar_thumb_glyph(buffer.cell((right_col, row)).unwrap().symbol())
            })
            .collect::<Vec<_>>();
        assert_eq!(*thumb_rows.first().unwrap(), 0);
        assert_eq!(
            thumb_rows.last().copied(),
            Some(TRANSCRIPT_SCROLLBAR_THUMB_ROWS - 1)
        );
    }

    #[test]
    fn scrollbar_offset_mapping_matches_thumb_ends() {
        let limit = 40usize;
        let track_height = 20u16;
        assert_eq!(
            transcript_scrollbar_offset_for_row(limit, 0, track_height, 0),
            limit,
            "pointer at top of track should show the oldest end"
        );
        assert_eq!(
            transcript_scrollbar_offset_for_row(limit, 0, track_height, track_height - 1),
            0,
            "pointer at bottom of track should show the newest end"
        );
        let mid = transcript_scrollbar_offset_for_row(limit, 0, track_height, 10);
        assert!(mid > 0 && mid < limit, "mid-track pointer should land mid-scroll");
    }

    #[test]
    fn non_scrollable_transcript_uses_full_width() {
        let transcript = TuiSection {
            kind: "transcript".to_string(),
            lines: vec![TuiLine {
                spans: vec![span("hello", false)],
            }],
        };
        let backend = TestBackend::new(20, 3);
        let mut terminal = Terminal::new(backend).unwrap();
        let mut snapshot = RenderSnapshot::default();
        terminal
            .draw(|frame| {
                snapshot = render_sections(
                    frame,
                    &[transcript],
                    frame.area(),
                    None,
                    TranscriptScroll::default(),
                );
            })
            .unwrap();

        assert_eq!(snapshot.transcript.unwrap().rect.width, 20);
    }
}

fn map_color(name: Option<&str>) -> Option<Color> {
    match name? {
        "black" => Some(Color::Black),
        "red" => Some(Color::Red),
        "green" => Some(Color::Green),
        "yellow" => Some(Color::Yellow),
        "blue" => Some(Color::Blue),
        "magenta" => Some(Color::Magenta),
        "cyan" => Some(Color::Cyan),
        "gray" | "grey" => Some(Color::DarkGray),
        "white" => Some(Color::White),
        value if value.starts_with("ansi256(") => {
            let digits: String = value.chars().filter(|c| c.is_ascii_digit()).collect();
            digits.parse::<u8>().ok().map(Color::Indexed)
        }
        _ => None,
    }
}
