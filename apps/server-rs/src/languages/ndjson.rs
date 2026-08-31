//! NDJSON readers for the probe (fd 3) and test-runner channels, mirrored
//! from ProbeEventReader.ts / TestEventReader.ts: line-based JSON with size
//! and count limits, validated field by field.

#![allow(dead_code)]

use serde::Deserialize;

use crate::protocol::ProbeFieldLayout;

const MAX_LINE: usize = 64 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawProbeEvent {
    pub protocol_version: u8,
    pub kind: String,
    pub probe_id: String,
    pub name: String,
    pub line: u32,
    pub column: u32,
    pub type_name: String,
    pub preview: String,
    pub truncated: bool,
    pub sequence: u64,
    #[serde(default)]
    pub bits: Option<u32>,
    #[serde(default)]
    pub size_bytes: Option<u64>,
    #[serde(default)]
    pub align_bytes: Option<u64>,
    #[serde(default)]
    pub fields: Option<Vec<ProbeFieldLayout>>,
}

pub struct ProbeReader<'a> {
    buffer: String,
    decoder: crate::util::Utf8Carry,
    events: u32,
    max_events: u32,
    on_event: Box<dyn FnMut(RawProbeEvent) + Send + 'a>,
    pub error: Option<String>,
}

impl<'a> ProbeReader<'a> {
    pub fn new(on_event: Box<dyn FnMut(RawProbeEvent) + Send + 'a>) -> Self {
        ProbeReader {
            buffer: String::new(),
            decoder: crate::util::Utf8Carry::new(),
            events: 0,
            max_events: 10_000,
            on_event,
            error: None,
        }
    }

    pub fn push(&mut self, chunk: &[u8]) {
        if self.error.is_some() {
            return;
        }
        // Chunk boundaries land wherever the pipe cuts them; a multibyte
        // character split across two reads must not become U+FFFD inside a
        // preview.
        self.buffer.push_str(&self.decoder.decode(chunk));
        while let Some(newline) = self.buffer.find('\n') {
            let line: String = self.buffer.drain(..=newline).collect();
            let line = line.trim_end_matches('\n');
            if line.len() > MAX_LINE {
                self.error = Some("Probe event exceeds 64 KiB".into());
                return;
            }
            if !line.is_empty() {
                self.parse(line.to_string());
            }
            if self.error.is_some() {
                return;
            }
        }
        if self.buffer.len() > MAX_LINE {
            self.error = Some("Probe event exceeds 64 KiB".into());
        }
    }

    fn parse(&mut self, line: String) {
        self.events += 1;
        if self.events > self.max_events {
            self.error = Some("Probe event count exceeds run limit".into());
            return;
        }
        match serde_json::from_str::<RawProbeEvent>(&line) {
            Ok(event) if event.protocol_version == 1 && event.kind == "probe_value" => {
                (self.on_event)(event);
            }
            Ok(_) => self.error = Some("Invalid probe event schema".into()),
            Err(error) => self.error = Some(format!("Invalid probe JSON: {error}")),
        }
    }

    pub fn end(&mut self) {
        self.buffer.push_str(&self.decoder.finish());
        if self.error.is_none() && !self.buffer.trim().is_empty() {
            self.error = Some("Probe channel ended with partial NDJSON".into());
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
// The Test* prefix IS the wire format: serde derives the "test_start"/
// "test_result"/… kind tags from these names.
#[allow(clippy::enum_variant_names)]
pub enum RawTestEvent {
    TestStart {
        index: u32,
        name: String,
    },
    #[serde(rename_all = "camelCase")]
    TestResult {
        index: u32,
        name: String,
        status: RawTestStatus,
        duration_ns: f64,
        #[serde(default)]
        error: Option<String>,
    },
    TestSummary {
        passed: u32,
        failed: u32,
        skipped: u32,
        leaked: u32,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RawTestStatus {
    Passed,
    Failed,
    Skipped,
    Leaked,
}

#[derive(Deserialize)]
struct TestEnvelope {
    #[serde(rename = "protocolVersion")]
    protocol_version: u8,
    #[serde(flatten)]
    event: RawTestEvent,
}

pub struct TestReader<'a> {
    buffer: String,
    decoder: crate::util::Utf8Carry,
    events: u32,
    max_events: u32,
    on_event: Box<dyn FnMut(RawTestEvent) + Send + 'a>,
    pub error: Option<String>,
}

impl<'a> TestReader<'a> {
    pub fn new(on_event: Box<dyn FnMut(RawTestEvent) + Send + 'a>) -> Self {
        TestReader {
            buffer: String::new(),
            decoder: crate::util::Utf8Carry::new(),
            events: 0,
            max_events: 10_000,
            on_event,
            error: None,
        }
    }

    pub fn push(&mut self, chunk: &[u8]) {
        if self.error.is_some() {
            return;
        }
        self.buffer.push_str(&self.decoder.decode(chunk));
        while let Some(newline) = self.buffer.find('\n') {
            let line: String = self.buffer.drain(..=newline).collect();
            let line = line.trim_end_matches('\n');
            if line.len() > MAX_LINE {
                self.error = Some("Test event exceeds 64 KiB".into());
                return;
            }
            if !line.is_empty() {
                self.parse(line.to_string());
            }
            if self.error.is_some() {
                return;
            }
        }
        if self.buffer.len() > MAX_LINE {
            self.error = Some("Test event exceeds 64 KiB".into());
        }
    }

    fn parse(&mut self, line: String) {
        self.events += 1;
        if self.events > self.max_events {
            self.error = Some("Test event count exceeds run limit".into());
            return;
        }
        match serde_json::from_str::<TestEnvelope>(&line) {
            Ok(envelope) if envelope.protocol_version == 1 => (self.on_event)(envelope.event),
            Ok(_) => self.error = Some("Invalid test event".into()),
            Err(error) => self.error = Some(format!("Invalid test JSON: {error}")),
        }
    }

    pub fn end(&mut self) {
        self.buffer.push_str(&self.decoder.finish());
        if self.error.is_none() && !self.buffer.trim().is_empty() {
            self.error = Some("Test channel ended with partial NDJSON".into());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn probe_line(preview: &str) -> String {
        format!(
            concat!(
                r#"{{"protocolVersion":1,"kind":"probe_value","probeId":"p","name":"x","#,
                r#""line":1,"column":1,"typeName":"str","preview":"{}","truncated":false,"sequence":1}}"#,
                "\n"
            ),
            preview
        )
    }

    #[test]
    fn a_preview_split_mid_character_between_chunks_survives() {
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let out = Arc::clone(&seen);
        let mut reader = ProbeReader::new(Box::new(move |event| {
            out.lock().expect("seen").push(event.preview);
        }));
        let line = probe_line("señor 🎉");
        let bytes = line.as_bytes();
        // Cut inside the emoji.
        let cut = line.find('🎉').expect("emoji") + 2;
        reader.push(&bytes[..cut]);
        reader.push(&bytes[cut..]);
        reader.end();
        assert_eq!(reader.error, None);
        assert_eq!(seen.lock().expect("seen").as_slice(), ["señor 🎉"]);
    }

    #[test]
    fn a_foreign_protocol_version_is_an_error_not_a_guess() {
        let mut reader = ProbeReader::new(Box::new(|_| {}));
        reader.push(probe_line("x").replace("\"protocolVersion\":1", "\"protocolVersion\":2").as_bytes());
        assert!(reader.error.is_some());
    }

    #[test]
    fn a_partial_trailing_line_is_reported_at_end() {
        let mut reader = TestReader::new(Box::new(|_| {}));
        reader.push(br#"{"protocolVersion":1,"kind":"test_summary","#);
        reader.end();
        assert!(reader.error.is_some());
    }

    #[test]
    fn test_events_parse_and_unknown_kinds_are_refused() {
        let seen = Arc::new(Mutex::new(0u32));
        let out = Arc::clone(&seen);
        let mut reader = TestReader::new(Box::new(move |_| {
            *out.lock().expect("count") += 1;
        }));
        reader.push(
            concat!(
                r#"{"protocolVersion":1,"kind":"test_start","index":0,"name":"a"}"#,
                "\n",
                r#"{"protocolVersion":1,"kind":"test_result","index":0,"name":"a","status":"passed","durationNs":5}"#,
                "\n",
            )
            .as_bytes(),
        );
        assert_eq!(reader.error, None);
        assert_eq!(*seen.lock().expect("count"), 2);
        reader.push(br#"{"protocolVersion":1,"kind":"who_knows"}"#);
        reader.push(b"\n");
        assert!(reader.error.is_some());
    }
}
