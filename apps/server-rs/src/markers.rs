//! Runtime output marker parsing mirrored from
//! apps/server/src/compiler/RuntimeOutputParser.ts: strips
//! `\x1eZIGLIVE_LOG:…\x1f` markers and annotates the preceding text with the
//! marker's source location; stderr gets panic/error heuristics.

#![allow(dead_code)]

use std::collections::HashMap;

use crate::protocol::{LogSourceLocation, LoopInfo, OutputCategory, Stream};

pub type OutputEmit<'a> =
    Box<dyn FnMut(Stream, &str, OutputCategory, Option<LogSourceLocation>) + Send + 'a>;

pub struct MarkerParser<'a> {
    stream: Stream,
    detect_errors: bool,
    file_ids: HashMap<u32, String>,
    emit: OutputEmit<'a>,
    buffer: String,
    sticky_error: bool,
    log_counts: HashMap<String, u32>,
}

const MARKER_START: char = '\u{1e}';
const MARKER_END: char = '\u{1f}';
const MARKER_PREFIX: &str = "\u{1e}ZIGLIVE_LOG:";

struct ParsedMarker {
    start: usize,
    end: usize,
    file_id: u32,
    line: u32,
    column: u32,
    loop_info: Option<LoopInfo>,
}

fn find_marker(buffer: &str) -> Option<ParsedMarker> {
    let mut search_from = 0;
    while let Some(offset) = buffer[search_from..].find(MARKER_PREFIX) {
        let start = search_from + offset;
        let body_start = start + MARKER_PREFIX.len();
        let end_offset = buffer[body_start..].find(MARKER_END)?;
        let body = &buffer[body_start..body_start + end_offset];
        let end = body_start + end_offset + MARKER_END.len_utf8();
        if let Some(parsed) = parse_body(body, start, end) {
            return Some(parsed);
        }
        search_from = start + MARKER_PREFIX.len();
    }
    None
}

fn parse_body(body: &str, start: usize, end: usize) -> Option<ParsedMarker> {
    // fid:line:col[:loop_line:loop_col:variable:value]
    let mut rest = body;
    let take_number = |rest: &mut &str| -> Option<u32> {
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() {
            return None;
        }
        *rest = &rest[digits.len()..];
        digits.parse().ok()
    };
    let file_id = take_number(&mut rest)?;
    rest = rest.strip_prefix(':')?;
    let line = take_number(&mut rest)?;
    rest = rest.strip_prefix(':')?;
    let column = take_number(&mut rest)?;
    let mut loop_info = None;
    if let Some(mut tail) = rest.strip_prefix(':') {
        let loop_line = take_number(&mut tail)?;
        tail = tail.strip_prefix(':')?;
        let loop_column = take_number(&mut tail)?;
        tail = tail.strip_prefix(':')?;
        let variable: String = tail
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect();
        if variable.is_empty() || !variable.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') {
            return None;
        }
        let after = &tail[variable.len()..];
        let value = after.strip_prefix(':')?;
        loop_info = Some(LoopInfo {
            line: loop_line,
            column: loop_column,
            variable,
            value: value.to_string(),
        });
    } else if !rest.is_empty() {
        return None;
    }
    Some(ParsedMarker {
        start,
        end,
        file_id,
        line,
        column,
        loop_info,
    })
}

fn is_panic_line(line: &str) -> bool {
    let lower = line.to_lowercase();
    if lower.contains("panicked at") || lower.contains("traceback (most recent call last)") {
        return true;
    }
    if let Some(index) = lower.find("assertion ") {
        if lower[index..].contains("failed") {
            return true;
        }
    }
    // (?:^|\s)(?:thread \d+ )?panic:
    if let Some(index) = lower.find("panic:") {
        let before = &lower[..index];
        let head_ok = before.is_empty()
            || before.ends_with(char::is_whitespace)
            || {
                // optional "thread N " prefix
                let trimmed = before.trim_end();
                if let Some(thread_rest) = trimmed.strip_suffix(|c: char| c.is_ascii_digit()) {
                    let digits_start = thread_rest.len();
                    let digits_trimmed = trimmed[..digits_start]
                        .trim_end_matches(|c: char| c.is_ascii_digit());
                    digits_trimmed.ends_with("thread ")
                        && (digits_trimmed.len() <= "thread ".len()
                            || digits_trimmed[..digits_trimmed.len() - "thread ".len()]
                                .ends_with(char::is_whitespace)
                            || digits_trimmed.len() == "thread ".len())
                } else {
                    false
                }
            };
        if head_ok {
            return true;
        }
    }
    false
}

fn line_has_error(line: &str) -> bool {
    // /(?:^|\s)error:/i
    let lower = line.to_lowercase();
    let mut from = 0;
    while let Some(index) = lower[from..].find("error:") {
        let absolute = from + index;
        if absolute == 0
            || lower[..absolute]
                .chars()
                .last()
                .is_some_and(char::is_whitespace)
        {
            return true;
        }
        from = absolute + 1;
    }
    false
}

impl<'a> MarkerParser<'a> {
    pub fn new(
        stream: Stream,
        detect_errors: bool,
        file_ids: HashMap<u32, String>,
        emit: OutputEmit<'a>,
    ) -> Self {
        MarkerParser {
            stream,
            detect_errors,
            file_ids,
            emit,
            buffer: String::new(),
            sticky_error: false,
            log_counts: HashMap::new(),
        }
    }

    fn emit_text(&mut self, text: &str, location: Option<&LogSourceLocation>) {
        // Split into lines keeping trailing newlines: /[^\n]*\n|[^\n]+/g
        let mut rest = text;
        while !rest.is_empty() {
            let line = match rest.find('\n') {
                Some(index) => {
                    let (line, tail) = rest.split_at(index + 1);
                    rest = tail;
                    line
                }
                None => {
                    let line = rest;
                    rest = "";
                    line
                }
            };
            if self.detect_errors && is_panic_line(line) {
                self.sticky_error = true;
            }
            let line_is_error = self.detect_errors && (self.sticky_error || line_has_error(line));
            let source = if self.sticky_error {
                None
            } else {
                location.cloned()
            };
            (self.emit)(
                self.stream,
                line,
                if line_is_error {
                    OutputCategory::Error
                } else {
                    OutputCategory::Program
                },
                source,
            );
        }
    }

    pub fn push(&mut self, chunk: &str) {
        self.buffer.push_str(chunk);
        while let Some(marker) = find_marker(&self.buffer) {
            let path = self.file_ids.get(&marker.file_id).cloned();
            let count_key = format!(
                "{}:{}:{}",
                path.as_deref().unwrap_or("unknown"),
                marker.line,
                marker.column
            );
            let execution_index = self.log_counts.get(&count_key).copied().unwrap_or(0) + 1;
            self.log_counts.insert(count_key, execution_index);
            let location = LogSourceLocation {
                path,
                line: marker.line,
                column: marker.column,
                execution_index,
                loop_info: marker.loop_info.clone(),
            };
            let before = self.buffer[..marker.start].to_string();
            self.emit_text(&before, Some(&location));
            self.buffer.drain(..marker.end);
        }
        // Avoid emitting a partial marker: keep buffering if a MARKER_START is
        // pending without its terminator (mirrors the regex behaviour, which
        // simply does not match until the \x1f arrives).
        let _ = MARKER_START;
    }

    pub fn flush(&mut self) {
        let rest = std::mem::take(&mut self.buffer);
        self.emit_text(&rest, None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    type Emitted = (String, OutputCategory, Option<LogSourceLocation>);

    fn collect(chunks: &[&str], detect_errors: bool) -> Vec<Emitted> {
        let sink: Arc<Mutex<Vec<Emitted>>> = Arc::new(Mutex::new(Vec::new()));
        let out = Arc::clone(&sink);
        let mut file_ids = HashMap::new();
        file_ids.insert(1, "src/main.zig".to_string());
        let mut parser = MarkerParser::new(
            Stream::Stderr,
            detect_errors,
            file_ids,
            Box::new(move |_, chunk, category, location| {
                out.lock()
                    .expect("sink")
                    .push((chunk.to_string(), category, location));
            }),
        );
        for chunk in chunks {
            parser.push(chunk);
        }
        parser.flush();
        drop(parser);
        Arc::try_unwrap(sink).expect("sink").into_inner().expect("sink")
    }

    #[test]
    fn markers_annotate_preceding_text_and_count_executions() {
        let lines = collect(
            &["hola\n\u{1e}ZIGLIVE_LOG:1:4:9\u{1f}", "otra\n\u{1e}ZIGLIVE_LOG:1:4:9\u{1f}"],
            false,
        );
        assert_eq!(lines.len(), 2);
        let first = lines[0].2.as_ref().expect("location");
        assert_eq!((first.line, first.column, first.execution_index), (4, 9, 1));
        let second = lines[1].2.as_ref().expect("location");
        assert_eq!(second.execution_index, 2);
    }

    #[test]
    fn loop_markers_carry_variable_and_value() {
        let lines = collect(&["iter 1\n\u{1e}ZIGLIVE_LOG:1:3:5:2:5:i:1\u{1f}"], false);
        let info = lines[0].2.as_ref().and_then(|l| l.loop_info.as_ref()).expect("loop");
        assert_eq!((info.line, info.column, info.variable.as_str(), info.value.as_str()), (2, 5, "i", "1"));
    }

    #[test]
    fn panics_turn_sticky_error() {
        let lines = collect(&["thread 1 panic: boom\nsiguiente\n"], true);
        assert!(lines.iter().all(|(_, category, _)| *category == OutputCategory::Error));
    }
}
