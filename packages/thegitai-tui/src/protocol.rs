use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum ParentMessage {
    #[serde(rename = "frame")]
    Frame(TuiFrame),
    #[serde(rename = "clear")]
    Clear,
    // The parent used to write the terminal title escape to stdout itself, while
    // this process was writing frames to the same terminal. Two writers on one
    // TTY have no ordering guarantee, so the parent's write could land inside a
    // frame flush and split an escape sequence — the orphaned tail then printed
    // as literal text ("0m", "34;7H") over the status rows. Only the process that
    // owns the terminal may write to it, so the parent asks us instead.
    #[serde(rename = "title")]
    Title { text: String },
    #[serde(rename = "quit")]
    Quit,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct TuiFrame {
    pub cols: u16,
    pub rows: u16,
    pub gutter: u16,
    pub content_width: u16,
    pub spinner_frame: u8,
    pub transcript_scroll_limit: usize,
    pub transcript_scroll_offset: usize,
    pub sections: Vec<TuiSection>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TuiSection {
    pub kind: String,
    pub lines: Vec<TuiLine>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TuiLine {
    pub spans: Vec<TuiSpan>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TuiSpan {
    pub text: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub bg_color: Option<String>,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub dim: bool,
    #[serde(default)]
    pub inverse: bool,
    #[serde(default)]
    pub underline: bool,
    #[serde(default)]
    pub link_url: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum ChildMessage {
    #[serde(rename = "event")]
    Event(TuiEvent),
    #[serde(rename = "ready")]
    Ready { cols: u16, rows: u16 },
    #[serde(rename = "closed")]
    Closed,
}

#[derive(Debug, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TuiEvent {
    #[serde(rename_all = "camelCase")]
    Key {
        input: String,
        ctrl: bool,
        meta: bool,
        shift: bool,
        escape: bool,
        return_key: bool,
        tab: bool,
        backspace: bool,
        delete: bool,
        up_arrow: bool,
        down_arrow: bool,
        left_arrow: bool,
        right_arrow: bool,
        home: bool,
        end: bool,
        paste: bool,
        page_up: bool,
        page_down: bool,
    },
    Paste {
        text: String,
    },
    Resize {
        cols: u16,
        rows: u16,
    },
    SelectionCopy {
        text: String,
    },
    LinkCopy {
        url: String,
    },
    LinkOpen {
        url: String,
    },
    ContextMenu,
    #[serde(rename_all = "camelCase")]
    TranscriptScroll {
        delta_lines: i16,
    },
    #[serde(rename_all = "camelCase")]
    TranscriptScrollTo {
        offset: usize,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn key_json_uses_camel_case() {
        let event = TuiEvent::Key {
            input: String::new(),
            ctrl: false,
            meta: false,
            shift: false,
            escape: false,
            return_key: true,
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
            page_up: false,
            page_down: false,
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("returnKey"), "got: {}", json);
        assert!(!json.contains("return_key"), "got: {}", json);
    }

    #[test]
    fn transcript_scroll_json_uses_camel_case() {
        let event = TuiEvent::TranscriptScroll { delta_lines: 3 };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("transcriptScroll"), "got: {}", json);
        assert!(json.contains("deltaLines"), "got: {}", json);
        assert!(!json.contains("delta_lines"), "got: {}", json);
    }

    #[test]
    fn transcript_scroll_to_json_uses_camel_case() {
        let event = TuiEvent::TranscriptScrollTo { offset: 12 };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("transcriptScrollTo"), "got: {}", json);
        assert!(json.contains("offset"), "got: {}", json);
    }

    #[test]
    fn context_menu_json_uses_camel_case() {
        let event = TuiEvent::ContextMenu;
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("contextMenu"), "got: {}", json);
    }

    #[test]
    fn link_events_json_use_camel_case() {
        let copy = serde_json::to_string(&TuiEvent::LinkCopy {
            url: "https://example.com".to_string(),
        })
        .unwrap();
        assert!(copy.contains("linkCopy"), "got: {}", copy);

        let open = serde_json::to_string(&TuiEvent::LinkOpen {
            url: "https://example.com".to_string(),
        })
        .unwrap();
        assert!(open.contains("linkOpen"), "got: {}", open);
    }

    #[test]
    fn span_link_metadata_deserializes_from_camel_case() {
        let span: TuiSpan = serde_json::from_str(
            r#"{"text":"SEMrush","underline":true,"linkUrl":"https://www.semrush.com"}"#,
        )
        .unwrap();
        assert!(span.underline);
        assert_eq!(span.link_url.as_deref(), Some("https://www.semrush.com"));
    }
}
