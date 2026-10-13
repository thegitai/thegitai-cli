use ratatui::text::Span;

use crate::protocol::TuiLine;

#[derive(Default)]
enum EscapeState {
    #[default]
    Text,
    Escape,
    Intermediate,
    Csi,
    String {
        bell_terminates: bool,
    },
    StringEscape {
        bell_terminates: bool,
    },
}

fn strip_controls(text: &str, state: &mut EscapeState) -> String {
    let mut output = String::new();
    for ch in text.chars() {
        match *state {
            EscapeState::Text => match ch {
                '\u{1b}' => *state = EscapeState::Escape,
                '\u{9b}' => *state = EscapeState::Csi,
                '\u{9d}' => {
                    *state = EscapeState::String {
                        bell_terminates: true,
                    }
                }
                '\u{90}' | '\u{98}' | '\u{9e}' | '\u{9f}' => {
                    *state = EscapeState::String {
                        bell_terminates: false,
                    };
                }
                '\t' => output.push(ch),
                '\n' => output.push(' '),
                ch if ch.is_control() => {}
                ch => output.push(ch),
            },
            EscapeState::Escape => {
                *state = match ch {
                    '[' => EscapeState::Csi,
                    ']' => EscapeState::String {
                        bell_terminates: true,
                    },
                    'P' | 'X' | '^' | '_' => EscapeState::String {
                        bell_terminates: false,
                    },
                    ' '..='/' => EscapeState::Intermediate,
                    _ => EscapeState::Text,
                };
            }
            EscapeState::Intermediate | EscapeState::Csi => {
                if ch == '\u{1b}' {
                    *state = EscapeState::Escape;
                } else if ('@'..='~').contains(&ch)
                    || matches!(state, EscapeState::Intermediate) && ('0'..='?').contains(&ch)
                {
                    *state = EscapeState::Text;
                }
            }
            EscapeState::String { bell_terminates } => {
                if ch == '\u{9c}' || bell_terminates && ch == '\u{7}' {
                    *state = EscapeState::Text;
                } else if ch == '\u{1b}' {
                    *state = EscapeState::StringEscape { bell_terminates };
                }
            }
            EscapeState::StringEscape { bell_terminates } => {
                *state = if ch == '\\' || ch == '\u{9c}' || bell_terminates && ch == '\u{7}' {
                    EscapeState::Text
                } else {
                    EscapeState::String { bell_terminates }
                };
            }
        }
    }
    output
}

pub fn normalize_line(line: &TuiLine) -> TuiLine {
    let mut column = 0;
    let mut state = EscapeState::default();
    let spans = line
        .spans
        .iter()
        .map(|span| {
            let stripped = strip_controls(&span.text, &mut state);
            let mut text = String::new();
            for (index, part) in stripped.split('\t').enumerate() {
                if index > 0 {
                    let spaces = 8 - column % 8;
                    text.push_str(&" ".repeat(spaces));
                    column += spaces;
                }
                text.push_str(part);
                column += Span::raw(part).width();
            }
            let mut normalized = span.clone();
            normalized.text = text;
            normalized
        })
        .collect();
    TuiLine { spans }
}

pub fn normalize_title(text: &str) -> String {
    strip_controls(text, &mut EscapeState::default()).replace('\t', " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(parts: &[&str]) -> TuiLine {
        serde_json::from_value(serde_json::json!({
            "spans": parts.iter().map(|text| serde_json::json!({ "text": text })).collect::<Vec<_>>()
        })).unwrap()
    }

    #[test]
    fn terminal_text_preserves_payload_and_removes_control_sequences() {
        let cases = [
            ("plain text", "plain text"),
            ("a\tb\tc", "a       b       c"),
            ("12345678\tz", "12345678        z"),
            ("\t\ta\t", "                a       "),
            ("界\te\u{301}\t✅", "界      e\u{301}       ✅"),
            ("\u{1b}[31mred\u{1b}[0m\ttext", "red     text"),
            ("\u{1b}[38:2:1:2:3mcolor\u{1b}[0m", "color"),
            ("\u{1b}]0;title\u{7}payload", "payload"),
            (
                "\u{1b}]8;;https://example.com\u{1b}\\link\u{1b}]8;;\u{1b}\\",
                "link",
            ),
            ("\u{1b}Pignored\u{1b}\\payload", "payload"),
            ("\u{9b}2J\u{9d}title\u{9c}payload", "payload"),
            ("a\r\u{8}\u{7}\u{0}\u{b}\u{c}\u{7f}\u{85}b", "ab"),
            ("line\nnext", "line next"),
            ("\u{1b}(Bpayload", "payload"),
            ("payload\u{1b}[", "payload"),
        ];
        for (input, expected) in cases {
            let normalized = normalize_line(&line(&[input]));
            assert_eq!(normalized.spans[0].text, expected, "input: {input:?}");
            assert!(!normalized.spans[0].text.chars().any(char::is_control));
            assert_eq!(normalize_line(&normalized).spans[0].text, expected);
        }
    }

    #[test]
    fn escapes_and_tab_stops_continue_across_styled_spans() {
        let normalized = normalize_line(&line(&["a\u{1b}[", "31m\tb\u{1b}]0;", "title\u{7}\tc"]));
        assert_eq!(normalized.spans[0].text, "a");
        assert_eq!(normalized.spans[1].text, "       b");
        assert_eq!(normalized.spans[2].text, "       c");
    }

    #[test]
    fn window_title_cannot_embed_terminal_commands() {
        assert_eq!(
            normalize_title("TheGitAI\tproject\u{7}\u{1b}[2J\nready"),
            "TheGitAI project ready"
        );
    }
}
