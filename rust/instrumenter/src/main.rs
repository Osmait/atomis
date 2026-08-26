//! `rustlive-instrument` mirrors the CLI and JSON contract of
//! `runzig-instrument` so the server can drive both languages with the same
//! pipeline: read one source file, splice probe/log calls into a generated
//! copy, and print the probe catalog plus parse diagnostics to stdout.
mod instrument;

use instrument::{instrument, Mode, Output};
use std::fs;
use std::process::ExitCode;

const MAX_SOURCE_BYTES: u64 = 1024 * 1024;

#[derive(Default)]
struct Options {
    input: Option<String>,
    output: Option<String>,
    source_map: Option<String>,
    uri: String,
    version: u64,
    file_id: u32,
    auto_inspect: bool,
    entry: bool,
    manual_ids: Vec<String>,
}

fn push_json_string(out: &mut String, value: &str) {
    out.push('"');
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
    out.push('"');
}

fn render(result: &Output, options: &Options) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "{{\"protocolVersion\":1,\"documentVersion\":{}",
        options.version
    ));
    if result.generated.is_some() {
        out.push_str(",\"generatedPath\":");
        push_json_string(&mut out, options.output.as_deref().unwrap_or(""));
        out.push_str(",\"sourceMapPath\":");
        push_json_string(&mut out, options.source_map.as_deref().unwrap_or(""));
    }
    out.push_str(",\"probes\":[");
    for (index, probe) in result.probes.iter().enumerate() {
        if index != 0 {
            out.push(',');
        }
        out.push_str("{\"probeId\":");
        push_json_string(&mut out, &probe.probe_id);
        out.push_str(",\"name\":");
        push_json_string(&mut out, &probe.name);
        out.push_str(&format!(
            ",\"supported\":{}",
            if probe.supported { "true" } else { "false" }
        ));
        if let Some(reason) = probe.reason {
            out.push_str(",\"reason\":");
            push_json_string(&mut out, reason);
        }
        out.push_str(&format!(
            ",\"originalRange\":{{\"startLine\":{},\"startColumn\":{},\"endLine\":{},\"endColumn\":{},\"startByte\":{},\"endByte\":{}}}",
            probe.range.start_line,
            probe.range.start_column,
            probe.range.end_line,
            probe.range.end_column,
            probe.range.start_byte,
            probe.range.end_byte,
        ));
        if let Some(byte) = probe.insertion_byte {
            out.push_str(&format!(",\"insertionByte\":{byte}"));
        }
        out.push_str(&format!(
            ",\"mode\":\"{}\"}}",
            match probe.mode {
                Mode::Auto => "auto",
                Mode::Manual => "manual",
            }
        ));
    }
    out.push_str("],\"parseDiagnostics\":[");
    for (index, diagnostic) in result.parse_diagnostics.iter().enumerate() {
        if index != 0 {
            out.push(',');
        }
        out.push_str("{\"message\":");
        push_json_string(&mut out, &diagnostic.message);
        out.push_str(&format!(
            ",\"severity\":\"error\",\"line\":{},\"column\":{}}}",
            diagnostic.line, diagnostic.column
        ));
    }
    out.push_str("]}");
    out
}

fn parse_args() -> Result<Options, String> {
    let mut options = Options {
        uri: "file:///main.rs".into(),
        version: 1,
        auto_inspect: true,
        ..Options::default()
    };
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let mut value_for = |name: &str| {
            args.next()
                .ok_or_else(|| format!("missing value for {name}"))
        };
        match arg.as_str() {
            "--no-auto-inspect" => options.auto_inspect = false,
            "--entry" => options.entry = true,
            "--input" => options.input = Some(value_for("--input")?),
            "--output" => options.output = Some(value_for("--output")?),
            "--source-map" => options.source_map = Some(value_for("--source-map")?),
            "--uri" => options.uri = value_for("--uri")?,
            "--version" => {
                options.version = value_for("--version")?
                    .parse()
                    .map_err(|_| "invalid --version".to_string())?
            }
            "--file-id" => {
                options.file_id = value_for("--file-id")?
                    .parse()
                    .map_err(|_| "invalid --file-id".to_string())?
            }
            "--manual" => options.manual_ids.push(value_for("--manual")?),
            other => return Err(format!("invalid argument: {other}")),
        }
    }
    if options.input.is_none() {
        return Err("missing --input".into());
    }
    if options.output.is_none() {
        return Err("missing --output".into());
    }
    if options.source_map.is_none() {
        return Err("missing --source-map".into());
    }
    Ok(options)
}

fn main() -> ExitCode {
    let options = match parse_args() {
        Ok(options) => options,
        Err(message) => {
            eprintln!("rustlive-instrument: {message}");
            return ExitCode::FAILURE;
        }
    };
    let input = options.input.as_deref().unwrap_or_default();
    let metadata = match fs::metadata(input) {
        Ok(metadata) => metadata,
        Err(error) => {
            eprintln!("rustlive-instrument: cannot read {input}: {error}");
            return ExitCode::FAILURE;
        }
    };
    if metadata.len() > MAX_SOURCE_BYTES {
        eprintln!("rustlive-instrument: {input} exceeds 1 MiB");
        return ExitCode::FAILURE;
    }
    let source = match fs::read_to_string(input) {
        Ok(source) => source,
        Err(error) => {
            eprintln!("rustlive-instrument: cannot read {input}: {error}");
            return ExitCode::FAILURE;
        }
    };
    let result = instrument(
        &source,
        &options.uri,
        options.auto_inspect,
        &options.manual_ids,
        options.file_id,
        options.entry,
    );
    let json = render(&result, &options);
    if let Some(generated) = &result.generated {
        if let Err(error) = fs::write(options.output.as_deref().unwrap_or(""), generated) {
            eprintln!("rustlive-instrument: cannot write output: {error}");
            return ExitCode::FAILURE;
        }
        if let Err(error) = fs::write(options.source_map.as_deref().unwrap_or(""), &json) {
            eprintln!("rustlive-instrument: cannot write source map: {error}");
            return ExitCode::FAILURE;
        }
    }
    println!("{json}");
    ExitCode::SUCCESS
}
