//! Atomis session runtime for Rust: reports probe values as NDJSON on fd 3
//! and stderr source markers for instrumented log statements, mirroring the
//! Zig `runzig_runtime.zig` protocol. Injected as a module at the end of the
//! generated entry file; never part of the visible sources.
#![allow(dead_code)]

use std::fs::File;
use std::io::Write;
use std::mem::ManuallyDrop;
use std::os::fd::FromRawFd;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

const MAX_PREVIEW: usize = 512;

static SEQUENCE: AtomicU64 = AtomicU64::new(0);
static LOCK: Mutex<()> = Mutex::new(());

fn write_fd(fd: i32, bytes: &[u8]) {
    let mut file = ManuallyDrop::new(unsafe { File::from_raw_fd(fd) });
    let _ = file.write_all(bytes);
    let _ = file.flush();
}

fn push_json_escaped(out: &mut String, value: &str) {
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
}

fn short_type(name: &str) -> String {
    let mut out = String::new();
    let mut segment = String::new();
    for ch in name.chars() {
        if ch.is_alphanumeric() || ch == '_' || ch == ':' {
            segment.push(ch);
        } else {
            out.push_str(segment.rsplit("::").next().unwrap_or(&segment));
            segment.clear();
            out.push(ch);
        }
    }
    out.push_str(segment.rsplit("::").next().unwrap_or(&segment));
    out
}

fn truncate_preview(preview: String) -> (String, bool) {
    if preview.len() <= MAX_PREVIEW {
        return (preview, false);
    }
    let mut end = MAX_PREVIEW;
    while !preview.is_char_boundary(end) {
        end -= 1;
    }
    (format!("{}…", &preview[..end]), true)
}

pub struct Wrap<T>(pub T);

pub trait DebugProbe {
    fn atomis_preview(&self) -> (String, String);
}
pub trait FallbackProbe {
    fn atomis_preview(&self) -> (String, String);
}

impl<T: std::fmt::Debug> DebugProbe for Wrap<&T> {
    fn atomis_preview(&self) -> (String, String) {
        (format!("{:?}", self.0), short_type(std::any::type_name::<T>()))
    }
}
impl<T> FallbackProbe for &Wrap<&T> {
    fn atomis_preview(&self) -> (String, String) {
        let name = short_type(std::any::type_name::<T>());
        (format!("<no Debug: {name}>"), name)
    }
}

pub fn emit_probe(
    probe_id: &str,
    name: &str,
    line: u32,
    column: u32,
    preview: String,
    type_name: &str,
    size: usize,
    align: usize,
) {
    let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let (preview, truncated) = truncate_preview(preview);
    let mut record = String::with_capacity(preview.len() + 200);
    record.push_str("{\"protocolVersion\":1,\"kind\":\"probe_value\",\"probeId\":\"");
    push_json_escaped(&mut record, probe_id);
    record.push_str("\",\"name\":\"");
    push_json_escaped(&mut record, name);
    record.push_str(&format!("\",\"line\":{line},\"column\":{column},\"typeName\":\""));
    push_json_escaped(&mut record, type_name);
    record.push_str("\",\"preview\":\"");
    push_json_escaped(&mut record, &preview);
    record.push_str(&format!(
        "\",\"sizeBytes\":{size},\"alignBytes\":{align},\"truncated\":{truncated},\"sequence\":{sequence}}}\n"
    ));
    let guard = LOCK.lock();
    write_fd(3, record.as_bytes());
    drop(guard);
}

pub fn emit_log(fd: i32, file_id: u32, line: u32, column: u32) {
    let marker = format!("\u{1e}ATOMIS_LOG:{file_id}:{line}:{column}\u{1f}");
    let guard = LOCK.lock();
    write_fd(fd, marker.as_bytes());
    drop(guard);
}

pub fn emit_log_loop(
    fd: i32,
    file_id: u32,
    line: u32,
    column: u32,
    loop_line: u32,
    loop_column: u32,
    variable: &str,
    value_preview: String,
) {
    let (preview, _) = truncate_preview(value_preview);
    // The marker travels in-band: a preview carrying the marker's own
    // delimiters (or a newline) would cut the frame short and leak the rest
    // of it as phantom program output.
    let preview = preview
        .replace('\u{1e}', "?")
        .replace('\u{1f}', "?")
        .replace('\n', "\\n");
    let marker = format!(
        "\u{1e}ATOMIS_LOG:{file_id}:{line}:{column}:{loop_line}:{loop_column}:{variable}:{preview}\u{1f}"
    );
    let guard = LOCK.lock();
    write_fd(fd, marker.as_bytes());
    drop(guard);
}

#[macro_export]
macro_rules! atomis_probe {
    ($id:expr, $line:expr, $col:expr, $name:expr, $val:expr) => {{
        #[allow(unused_imports)]
        use $crate::__atomis_runtime::{DebugProbe as _, FallbackProbe as _};
        let (preview, type_name) =
            (&$crate::__atomis_runtime::Wrap($val)).atomis_preview();
        $crate::__atomis_runtime::emit_probe(
            $id,
            $name,
            $line,
            $col,
            preview,
            &type_name,
            ::std::mem::size_of_val($val),
            ::std::mem::align_of_val($val),
        );
    }};
}

#[macro_export]
macro_rules! atomis_log {
    ($fd:expr, $file:expr, $line:expr, $col:expr) => {
        $crate::__atomis_runtime::emit_log($fd, $file, $line, $col)
    };
}

#[macro_export]
macro_rules! atomis_log_loop {
    // `captured`: the preview was taken at the top of the loop body (see
    // atomis_loop_capture!), before any statement could move the variable —
    // referencing the variable itself here was a use-after-move whenever
    // the body consumed it before printing.
    ($fd:expr, $file:expr, $line:expr, $col:expr, $lline:expr, $lcol:expr, $var:expr, captured $val:expr) => {{
        $crate::__atomis_runtime::emit_log_loop(
            $fd,
            $file,
            $line,
            $col,
            $lline,
            $lcol,
            $var,
            ::std::clone::Clone::clone($val),
        );
    }};
    ($fd:expr, $file:expr, $line:expr, $col:expr, $lline:expr, $lcol:expr, $var:expr, $val:expr) => {{
        #[allow(unused_imports)]
        use $crate::__atomis_runtime::{DebugProbe as _, FallbackProbe as _};
        let (preview, _) = (&$crate::__atomis_runtime::Wrap($val)).atomis_preview();
        $crate::__atomis_runtime::emit_log_loop($fd, $file, $line, $col, $lline, $lcol, $var, preview);
    }};
}

/// Formats a probe-style preview of `$val` RIGHT NOW, yielding the String.
/// Spliced at the top of a loop body so later moves cannot invalidate it.
#[macro_export]
macro_rules! atomis_loop_capture {
    ($val:expr) => {{
        #[allow(unused_imports)]
        use $crate::__atomis_runtime::{DebugProbe as _, FallbackProbe as _};
        let (preview, _) = (&$crate::__atomis_runtime::Wrap($val)).atomis_preview();
        preview
    }};
}
