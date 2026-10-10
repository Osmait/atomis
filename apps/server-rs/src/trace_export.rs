//! Span timelines in the Chrome Trace Event format, for Perfetto.
//!
//! `ATOMIS_TRACE=/path/trace.json` makes every span the server records end
//! up in that file as a complete event: its start, its duration, and the
//! fields it was created with. Open the file in https://ui.perfetto.dev (or
//! feed it to `scripts/trace-report.py`) and each run is a row: the phases,
//! every process it started, the time between them.
//!
//! A CPU profile cannot show time spent waiting, and waiting is where the
//! ~40 ms Nagle delay hid. This is the wall-clock view.
//!
//! Spans are recorded from creation to close, not per poll: an async span
//! is entered and left at every await, and only its whole life is the time
//! someone waited. A span with a `run` field starts a row of its own; spans
//! below it land on the same row. Timestamps are Unix microseconds, the
//! clock a client in the same machine can stamp its own events with.
//!
//! No crate: the format is one JSON object per span, and the server's
//! dependency list is short on purpose.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::fs::File;
use std::io::{BufWriter, Write as _};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Id};
use tracing::Subscriber;
use tracing_subscriber::layer::Context;
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::Layer;

/// Only our own spans; dependencies' would bury the runs.
const TARGET: &str = "atomis_server";

pub struct ChromeTrace {
    out: Mutex<Output>,
}

struct Output {
    writer: BufWriter<File>,
    /// Row name → Perfetto thread id, numbered in order of appearance.
    rows: HashMap<String, u64>,
}

/// What a span carries from creation to close.
struct Recorded {
    start_us: u64,
    args: Vec<(String, String)>,
    row: String,
}

#[derive(Default)]
struct Fields(Vec<(String, String)>);

impl Visit for Fields {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.0.push((field.name().to_string(), value.to_string()));
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.0.push((field.name().to_string(), format!("{value:?}")));
    }
}

fn now_us() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_micros() as u64)
        .unwrap_or(0)
}

fn json_string(out: &mut String, text: &str) {
    out.push('"');
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            control if (control as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", control as u32);
            }
            other => out.push(other),
        }
    }
    out.push('"');
}

impl ChromeTrace {
    /// The layer for `ATOMIS_TRACE`, or `None` when it is unset or the file
    /// cannot be created (said once on stderr; the server runs regardless).
    pub fn from_env() -> Option<Self> {
        let path = std::env::var_os("ATOMIS_TRACE")?;
        match File::create(&path) {
            Ok(file) => Some(Self::new(file)),
            Err(error) => {
                eprintln!("ATOMIS_TRACE: cannot create {}: {error}", path.to_string_lossy());
                None
            }
        }
    }
}

impl ChromeTrace {
    fn new(file: File) -> Self {
        let mut writer = BufWriter::new(file);
        // An array the viewer accepts unterminated, so a server that is
        // killed still leaves a readable trace.
        let _ = writer.write_all(b"[\n");
        ChromeTrace { out: Mutex::new(Output { writer, rows: HashMap::new() }) }
    }
}

impl<S> Layer<S> for ChromeTrace
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_new_span(&self, attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
        if !attrs.metadata().target().starts_with(TARGET) {
            return;
        }
        let Some(span) = ctx.span(id) else { return };
        let mut fields = Fields::default();
        attrs.record(&mut fields);
        let own_row = fields.0.iter().find(|(name, _)| name == "run").map(|(_, value)| format!("run {value}"));
        let row = own_row
            .or_else(|| {
                span.parent()
                    .and_then(|parent| parent.extensions().get::<Recorded>().map(|recorded| recorded.row.clone()))
            })
            .unwrap_or_else(|| "server".to_string());
        span.extensions_mut().insert(Recorded { start_us: now_us(), args: fields.0, row });
    }

    fn on_close(&self, id: Id, ctx: Context<'_, S>) {
        let Some(span) = ctx.span(&id) else { return };
        let extensions = span.extensions();
        let Some(recorded) = extensions.get::<Recorded>() else { return };
        let duration = now_us().saturating_sub(recorded.start_us);
        // A `label` field names the box (the program a process span ran,
        // the phase a phase span is); the span's own name otherwise.
        let name = recorded
            .args
            .iter()
            .find(|(field, _)| field == "label")
            .map(|(_, value)| format!("{} {value}", span.name()))
            .unwrap_or_else(|| span.name().to_string());
        let Ok(mut out) = self.out.lock() else { return };
        let next = out.rows.len() as u64 + 1;
        let (tid, new_row) = match out.rows.get(&recorded.row) {
            Some(tid) => (*tid, false),
            None => {
                out.rows.insert(recorded.row.clone(), next);
                (next, true)
            }
        };
        let mut line = String::with_capacity(256);
        if new_row {
            line.push_str("{\"ph\":\"M\",\"name\":\"thread_name\",\"pid\":1,\"tid\":");
            let _ = write!(line, "{tid},\"args\":{{\"name\":");
            json_string(&mut line, &recorded.row);
            line.push_str("}},\n");
        }
        line.push_str("{\"ph\":\"X\",\"pid\":1,\"tid\":");
        let _ = write!(line, "{tid},\"ts\":{},\"dur\":{duration},\"name\":", recorded.start_us);
        json_string(&mut line, &name);
        line.push_str(",\"args\":{");
        for (index, (field, value)) in recorded.args.iter().enumerate() {
            if index > 0 {
                line.push(',');
            }
            json_string(&mut line, field);
            line.push(':');
            json_string(&mut line, value);
        }
        line.push_str("}},\n");
        let _ = out.writer.write_all(line.as_bytes());
        // Rare enough to flush each time, and a crash keeps everything.
        let _ = out.writer.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tracing_subscriber::layer::SubscriberExt;

    #[test]
    fn spans_become_complete_events_on_their_run_row() {
        let path = std::env::temp_dir().join(format!("atomis-trace-{}.json", crate::util::random_hex(6)));
        let layer = ChromeTrace::new(File::create(&path).unwrap());
        let subscriber = tracing_subscriber::registry().with(layer);
        tracing::subscriber::with_default(subscriber, || {
            let run = tracing::info_span!("run", run = "ab12", language = "zig");
            let _entered = run.enter();
            tracing::info_span!("process", label = "zig \"build\"").in_scope(|| {});
        });
        let text = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        // A row named after the run, and both spans on it.
        assert!(text.contains("\"name\":\"run ab12\""), "{text}");
        let events: Vec<&str> = text.lines().filter(|line| line.contains("\"ph\":\"X\"")).collect();
        assert_eq!(events.len(), 2, "{text}");
        assert!(events.iter().all(|event| event.contains("\"tid\":1,")));
        assert!(events[0].contains("\"name\":\"process zig \\\"build\\\"\""), "{}", events[0]);
        assert!(events[1].contains("\"language\":\"zig\""));
        // Every line parses once the array is closed.
        let closed = format!("{}]", text.trim_end().trim_end_matches(','));
        assert!(serde_json::from_str::<serde_json::Value>(&closed).is_ok(), "{closed}");
    }
}
