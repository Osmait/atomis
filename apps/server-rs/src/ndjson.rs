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
    events: u32,
    max_events: u32,
    on_event: Box<dyn FnMut(RawProbeEvent) + Send + 'a>,
    pub error: Option<String>,
}

impl<'a> ProbeReader<'a> {
    pub fn new(on_event: Box<dyn FnMut(RawProbeEvent) + Send + 'a>) -> Self {
        ProbeReader {
            buffer: String::new(),
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
        self.buffer.push_str(&String::from_utf8_lossy(chunk));
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
        if self.error.is_none() && !self.buffer.trim().is_empty() {
            self.error = Some("Probe channel ended with partial NDJSON".into());
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
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
    events: u32,
    max_events: u32,
    on_event: Box<dyn FnMut(RawTestEvent) + Send + 'a>,
    pub error: Option<String>,
}

impl<'a> TestReader<'a> {
    pub fn new(on_event: Box<dyn FnMut(RawTestEvent) + Send + 'a>) -> Self {
        TestReader {
            buffer: String::new(),
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
        self.buffer.push_str(&String::from_utf8_lossy(chunk));
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
        if self.error.is_none() && !self.buffer.trim().is_empty() {
            self.error = Some("Test channel ended with partial NDJSON".into());
        }
    }
}
