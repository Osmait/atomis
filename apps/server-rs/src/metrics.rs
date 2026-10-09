//! What the server is doing, in the Prometheus text format.
//!
//! A hosting dashboard shows the container from outside — CPU, memory,
//! network — and cannot say why: whether a memory plateau is six open
//! rust-analyzers or one leak, or whether CPU is a burst of Zig builds.
//! These numbers are the inside half. Counters live in one process-wide
//! registry so the run path records into it without threading a handle
//! through every layer; the gauges are read at scrape time from the state
//! that already holds them.
//!
//! No metrics crate: a few atomics and a text writer are the whole format,
//! and the server's dependency list is short on purpose.

use std::fmt::Write as _;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::LazyLock;

use crate::languages::runtime::TerminalState;
use crate::protocol::{Language, LANGUAGES};

/// Upper bounds of the run-duration histogram, in seconds: a warm Python run
/// lands in the first bucket, a cold Zig or Go build in the last ones.
const BUCKETS: [f64; 9] = [0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0];

const OUTCOMES: [&str; 5] = ["succeeded", "compile_error", "runtime_error", "timed_out", "cancelled"];
const PHASES: [&str; 3] = ["instrument", "compile", "execute"];

struct LanguageMetrics {
    outcomes: [AtomicU64; OUTCOMES.len()],
    /// Cumulative, per BUCKETS entry; the count is the +Inf bucket.
    buckets: [AtomicU64; BUCKETS.len()],
    count: AtomicU64,
    /// Microseconds, so an integer atomic can hold the sum.
    wall_micros: AtomicU64,
    phase_micros: [AtomicU64; PHASES.len()],
}

impl LanguageMetrics {
    fn new() -> Self {
        LanguageMetrics {
            outcomes: Default::default(),
            buckets: Default::default(),
            count: AtomicU64::new(0),
            wall_micros: AtomicU64::new(0),
            phase_micros: Default::default(),
        }
    }
}

pub struct Metrics {
    languages: [LanguageMetrics; LANGUAGES.len()],
    runs_in_flight: AtomicI64,
    runs_queued: AtomicI64,
}

pub static METRICS: LazyLock<Metrics> = LazyLock::new(|| Metrics {
    languages: std::array::from_fn(|_| LanguageMetrics::new()),
    runs_in_flight: AtomicI64::new(0),
    runs_queued: AtomicI64::new(0),
});

fn index(language: Language) -> usize {
    LANGUAGES
        .iter()
        .position(|candidate| *candidate == language)
        .unwrap_or(0)
}

fn micros(ms: f64) -> u64 {
    (ms.max(0.0) * 1000.0) as u64
}

/// Counts a run as in flight until dropped, so a run that panics or is
/// cancelled midway still leaves the gauge where it found it.
pub struct InFlight;

impl Drop for InFlight {
    fn drop(&mut self) {
        METRICS.runs_in_flight.fetch_sub(1, Ordering::Relaxed);
    }
}

/// The same, for a run waiting for a free slot.
pub struct Queued;

impl Drop for Queued {
    fn drop(&mut self) {
        METRICS.runs_queued.fetch_sub(1, Ordering::Relaxed);
    }
}

impl Metrics {
    pub fn run_queued(&self) -> Queued {
        self.runs_queued.fetch_add(1, Ordering::Relaxed);
        Queued
    }

    pub fn run_started(&self) -> InFlight {
        self.runs_in_flight.fetch_add(1, Ordering::Relaxed);
        InFlight
    }

    pub fn run_finished(
        &self,
        language: Language,
        state: TerminalState,
        wall_seconds: f64,
        result: &crate::protocol::RunResult,
    ) {
        let entry = &self.languages[index(language)];
        let outcome = match state {
            TerminalState::Succeeded => 0,
            TerminalState::CompileError => 1,
            TerminalState::RuntimeError => 2,
            TerminalState::TimedOut => 3,
            TerminalState::Cancelled => 4,
        };
        entry.outcomes[outcome].fetch_add(1, Ordering::Relaxed);
        for (bound, bucket) in BUCKETS.iter().zip(&entry.buckets) {
            if wall_seconds <= *bound {
                bucket.fetch_add(1, Ordering::Relaxed);
            }
        }
        entry.count.fetch_add(1, Ordering::Relaxed);
        entry
            .wall_micros
            .fetch_add(micros(wall_seconds * 1000.0), Ordering::Relaxed);
        for (phase, ms) in [
            result.instrumentation_ms,
            result.compilation_ms,
            result.execution_ms,
        ]
        .into_iter()
        .enumerate()
        {
            entry.phase_micros[phase].fetch_add(micros(ms), Ordering::Relaxed);
        }
    }
}

/// What the scrape reads from the live state rather than from counters.
pub struct Gauges {
    pub sessions: usize,
    /// Running language servers, per language id.
    pub lsp_servers: Vec<(&'static str, usize)>,
}

/// CPU and memory as this process's cgroup counts them — in a container,
/// the container's, which is what a host bills — or nothing outside a
/// cgroup v2 hierarchy.
fn cgroup() -> Option<(f64, u64)> {
    // `0::/path`, relative to the cgroup mount. Inside a container's cgroup
    // namespace the path is `/`, and on a host it is the service's own.
    let own = std::fs::read_to_string("/proc/self/cgroup").ok()?;
    let relative = own.lines().find_map(|line| line.strip_prefix("0::"))?.trim();
    let dir = std::path::Path::new("/sys/fs/cgroup").join(relative.trim_start_matches('/'));
    let cpu = std::fs::read_to_string(dir.join("cpu.stat")).ok()?;
    let usage = cpu
        .lines()
        .find_map(|line| line.strip_prefix("usage_usec "))?
        .trim()
        .parse::<u64>()
        .ok()?;
    let memory = std::fs::read_to_string(dir.join("memory.current"))
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()?;
    Some((usage as f64 / 1e6, memory))
}

/// This process alone, plus the children it has reaped: every compiler and
/// program a run spawned ends up in cutime/cstime once it exits.
fn process() -> Option<(f64, u64)> {
    let stat = std::fs::read_to_string("/proc/self/stat").ok()?;
    // The command name is parenthesised and may contain spaces; fields
    // start after its closing paren.
    let fields: Vec<&str> = stat.rsplit_once(')')?.1.split_whitespace().collect();
    let ticks = |i: usize| fields.get(i).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
    // utime, stime, cutime, cstime are fields 14-17 of the line, 11-14 here.
    let cpu_ticks = ticks(11) + ticks(12) + ticks(13) + ticks(14);
    let hertz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) }.max(1) as f64;
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let rss_kb = status
        .lines()
        .find_map(|line| line.strip_prefix("VmRSS:"))
        .and_then(|value| value.trim().trim_end_matches("kB").trim().parse::<u64>().ok())
        .unwrap_or(0);
    Some((cpu_ticks as f64 / hertz, rss_kb * 1024))
}

fn header(out: &mut String, name: &str, kind: &str, help: &str) {
    let _ = writeln!(out, "# HELP {name} {help}\n# TYPE {name} {kind}");
}

pub fn render(gauges: &Gauges) -> String {
    let metrics = &*METRICS;
    let mut out = String::with_capacity(8192);

    header(&mut out, "atomis_runs_total", "counter", "Finished runs by language and outcome.");
    for (language, entry) in LANGUAGES.iter().zip(&metrics.languages) {
        for (outcome, counter) in OUTCOMES.iter().zip(&entry.outcomes) {
            let value = counter.load(Ordering::Relaxed);
            if value > 0 {
                let language = language.as_str();
                let _ = writeln!(out, "atomis_runs_total{{language=\"{language}\",outcome=\"{outcome}\"}} {value}");
            }
        }
    }

    let name = "atomis_run_duration_seconds";
    header(&mut out, name, "histogram", "Wall time of a run, request to result.");
    for (language, entry) in LANGUAGES.iter().zip(&metrics.languages) {
        let count = entry.count.load(Ordering::Relaxed);
        if count == 0 {
            continue;
        }
        let language = language.as_str();
        for (bound, bucket) in BUCKETS.iter().zip(&entry.buckets) {
            let value = bucket.load(Ordering::Relaxed);
            let _ = writeln!(out, "{name}_bucket{{language=\"{language}\",le=\"{bound}\"}} {value}");
        }
        let sum = entry.wall_micros.load(Ordering::Relaxed) as f64 / 1e6;
        let _ = writeln!(out, "{name}_bucket{{language=\"{language}\",le=\"+Inf\"}} {count}");
        let _ = writeln!(out, "{name}_sum{{language=\"{language}\"}} {sum}");
        let _ = writeln!(out, "{name}_count{{language=\"{language}\"}} {count}");
    }

    let name = "atomis_run_phase_seconds_total";
    header(&mut out, name, "counter", "Time spent per run phase, as the runner reports it.");
    for (language, entry) in LANGUAGES.iter().zip(&metrics.languages) {
        if entry.count.load(Ordering::Relaxed) == 0 {
            continue;
        }
        let language = language.as_str();
        for (phase, total) in PHASES.iter().zip(&entry.phase_micros) {
            let seconds = total.load(Ordering::Relaxed) as f64 / 1e6;
            let _ = writeln!(out, "{name}{{language=\"{language}\",phase=\"{phase}\"}} {seconds}");
        }
    }

    header(&mut out, "atomis_runs_in_flight", "gauge", "Runs currently compiling or executing.");
    let _ = writeln!(out, "atomis_runs_in_flight {}", metrics.runs_in_flight.load(Ordering::Relaxed));
    header(&mut out, "atomis_runs_queued", "gauge", "Runs waiting for a free slot (ATOMIS_MAX_CONCURRENT_RUNS).");
    let _ = writeln!(out, "atomis_runs_queued {}", metrics.runs_queued.load(Ordering::Relaxed));
    header(&mut out, "atomis_sessions", "gauge", "Live sessions, including those in their reconnect grace.");
    let _ = writeln!(out, "atomis_sessions {}", gauges.sessions);
    header(&mut out, "atomis_lsp_servers", "gauge", "Running language servers by language.");
    for (language, count) in &gauges.lsp_servers {
        let _ = writeln!(out, "atomis_lsp_servers{{language=\"{language}\"}} {count}");
    }

    if let Some((cpu, rss)) = process() {
        header(&mut out, "atomis_process_cpu_seconds_total", "counter", "CPU of the server plus its reaped children.");
        let _ = writeln!(out, "atomis_process_cpu_seconds_total {cpu}");
        header(&mut out, "atomis_process_resident_bytes", "gauge", "Resident memory of the server process alone.");
        let _ = writeln!(out, "atomis_process_resident_bytes {rss}");
    }
    if let Some((cpu, memory)) = cgroup() {
        header(&mut out, "atomis_cgroup_cpu_seconds_total", "counter", "CPU of the whole container, as the host bills it.");
        let _ = writeln!(out, "atomis_cgroup_cpu_seconds_total {cpu}");
        header(&mut out, "atomis_cgroup_memory_bytes", "gauge", "Memory of the whole container, as the host bills it.");
        let _ = writeln!(out, "atomis_cgroup_memory_bytes {memory}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::RunResult;

    #[test]
    fn a_finished_run_lands_in_its_buckets_and_under_its_family() {
        METRICS.run_finished(
            Language::Py,
            TerminalState::Succeeded,
            0.2,
            &RunResult {
                instrumentation_ms: 10.0,
                compilation_ms: 0.0,
                execution_ms: 5.0,
                ..RunResult::default()
            },
        );
        let text = render(&Gauges { sessions: 2, lsp_servers: vec![("py", 1)] });
        assert!(text.contains("atomis_runs_total{language=\"py\",outcome=\"succeeded\"}"));
        // 0.2s is above the 0.1 bound and within 0.25.
        let bucket = |le: &str| {
            text.lines()
                .find(|line| line.starts_with(&format!("atomis_run_duration_seconds_bucket{{language=\"py\",le=\"{le}\"}}")))
                .and_then(|line| line.rsplit(' ').next())
                .and_then(|value| value.parse::<u64>().ok())
                .expect("bucket")
        };
        assert!(bucket("0.25") >= 1);
        assert!(bucket("0.25") > bucket("0.1"));
        assert!(text.contains("atomis_sessions 2"));
        assert!(text.contains("atomis_lsp_servers{language=\"py\"} 1"));
        // Every sample sits after its own TYPE line.
        let histogram_type = text.find("# TYPE atomis_run_duration_seconds histogram").expect("type");
        let first_bucket = text.find("atomis_run_duration_seconds_bucket").expect("bucket");
        assert!(histogram_type < first_bucket);
    }

    #[test]
    fn the_in_flight_gauge_returns_when_the_guard_drops() {
        let before = METRICS.runs_in_flight.load(Ordering::Relaxed);
        {
            let _guard = METRICS.run_started();
            assert_eq!(METRICS.runs_in_flight.load(Ordering::Relaxed), before + 1);
        }
        assert_eq!(METRICS.runs_in_flight.load(Ordering::Relaxed), before);
    }
}
