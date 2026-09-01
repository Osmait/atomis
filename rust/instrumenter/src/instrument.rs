//! Pure instrumentation logic: parses a Rust source with syn, records probe
//! insertion points for simple `let` bindings and source markers for direct
//! log-macro statements, then splices the calls into the ORIGINAL text so the
//! generated copy keeps every byte and the exact newline count of the input.
use proc_macro2::Span;
use syn::spanned::Spanned;
use syn::visit::Visit;

#[derive(Debug, Clone)]
pub struct Range {
    pub start_line: usize,
    pub start_column: usize,
    pub end_line: usize,
    pub end_column: usize,
    pub start_byte: usize,
    pub end_byte: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Mode {
    Auto,
    Manual,
}

#[derive(Debug, Clone)]
pub struct Probe {
    pub probe_id: String,
    pub name: String,
    pub supported: bool,
    pub reason: Option<&'static str>,
    pub range: Range,
    pub insertion_byte: Option<usize>,
    pub mode: Mode,
}

#[derive(Debug, Clone)]
pub struct ParseDiagnostic {
    pub message: String,
    pub line: usize,
    pub column: usize,
}

#[derive(Debug)]
pub struct Output {
    pub generated: Option<String>,
    pub probes: Vec<Probe>,
    pub parse_diagnostics: Vec<ParseDiagnostic>,
}

const LOG_MACROS: [&str; 5] = ["println", "print", "eprintln", "eprint", "dbg"];
const STDERR_MACROS: [&str; 3] = ["eprintln", "eprint", "dbg"];

fn fnv1a64(input: &str) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in input.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn probe_id(uri: &str, range: &Range, name: &str) -> String {
    let key = format!(
        "rustlive-v1|{uri}|{}-{}|{name}",
        range.start_byte, range.end_byte
    );
    format!("{:016x}{:016x}", fnv1a64(&key), fnv1a64(&format!("{key}|2")))
}

fn span_range(span: Span) -> Range {
    let bytes = span.byte_range();
    let start = span.start();
    let end = span.end();
    Range {
        start_line: start.line,
        start_column: start.column + 1,
        end_line: end.line,
        end_column: end.column + 1,
        start_byte: bytes.start,
        end_byte: bytes.end,
    }
}

#[derive(Clone)]
struct LoopMeta {
    line: usize,
    column: usize,
    variable: Option<String>,
    /// Where the preview of the loop variable is captured — the top of the
    /// body, before any statement can move the variable away.
    shadow: String,
    body_start: usize,
    used: bool,
}

struct Collector<'a> {
    uri: &'a str,
    file_id: u32,
    auto_inspect: bool,
    manual_ids: &'a [String],
    probes: Vec<Probe>,
    insertions: Vec<(usize, String)>,
    loops: Vec<LoopMeta>,
    loop_counter: usize,
    test_depth: usize,
    /// Inside `const fn`, `const {}`, or a `const`/`static` initializer:
    /// the runtime does I/O, and I/O in a const context is a compile error
    /// injected into perfectly valid user code.
    const_depth: usize,
}

fn is_test_attr(attrs: &[syn::Attribute]) -> bool {
    attrs.iter().any(|attr| {
        let path = attr.path();
        if path.segments.last().map(|segment| segment.ident == "test") == Some(true) {
            return true;
        }
        if path.is_ident("cfg") {
            let mut is_test = false;
            let _ = attr.parse_nested_meta(|meta| {
                if meta.path.is_ident("test") {
                    is_test = true;
                }
                Ok(())
            });
            return is_test;
        }
        false
    })
}

fn first_ident(expr: &syn::Expr) -> Option<String> {
    struct Finder(Option<String>);
    impl<'ast> Visit<'ast> for Finder {
        fn visit_expr_path(&mut self, path: &'ast syn::ExprPath) {
            if self.0.is_none() && path.qself.is_none() {
                if let Some(ident) = path.path.get_ident() {
                    self.0 = Some(ident.to_string());
                }
            }
        }
    }
    let mut finder = Finder(None);
    finder.visit_expr(expr);
    finder.0
}

impl<'a> Collector<'a> {
    fn active(&self, id: &str) -> bool {
        self.auto_inspect || self.manual_ids.iter().any(|manual| manual == id)
    }

    fn push_loop(&mut self, line: usize, column: usize, variable: Option<String>, body_start: usize) {
        self.loop_counter += 1;
        self.loops.push(LoopMeta {
            line,
            column,
            variable,
            shadow: format!("__atomis_loop_v{}", self.loop_counter),
            body_start,
            used: false,
        });
    }

    fn pop_loop(&mut self) {
        let Some(meta) = self.loops.pop() else { return };
        if !meta.used {
            return;
        }
        if let Some(variable) = &meta.variable {
            self.insertions.push((
                meta.body_start,
                format!(
                    " let {shadow} = crate::atomis_loop_capture!(&{variable});",
                    shadow = meta.shadow
                ),
            ));
        }
    }

    /// Loop context must not leak into a closure, an async block or a
    /// nested item: a marker in there referencing the loop variable changes
    /// what the closure captures (or simply cannot name it at all, E0434).
    fn with_loop_barrier(&mut self, visit: impl FnOnce(&mut Self)) {
        let saved = std::mem::take(&mut self.loops);
        visit(self);
        self.loops = saved;
    }

    fn local_ident(pat: &syn::Pat) -> Result<Option<&syn::PatIdent>, &'static str> {
        match pat {
            syn::Pat::Ident(ident) => {
                if ident.subpat.is_some() {
                    Err("pattern with a @ subpattern")
                } else {
                    Ok(Some(ident))
                }
            }
            syn::Pat::Type(typed) => Self::local_ident(&typed.pat),
            syn::Pat::Wild(_) => Ok(None),
            syn::Pat::Tuple(_) | syn::Pat::TupleStruct(_) | syn::Pat::Struct(_) => {
                Err("destructuring pattern")
            }
            _ => Err("unsupported pattern"),
        }
    }
}

impl<'a, 'ast> Visit<'ast> for Collector<'a> {
    fn visit_item_fn(&mut self, item: &'ast syn::ItemFn) {
        let test = is_test_attr(&item.attrs);
        let konst = item.sig.constness.is_some();
        if test {
            self.test_depth += 1;
        }
        if konst {
            self.const_depth += 1;
        }
        self.with_loop_barrier(|c| syn::visit::visit_item_fn(c, item));
        if konst {
            self.const_depth -= 1;
        }
        if test {
            self.test_depth -= 1;
        }
    }

    fn visit_impl_item_fn(&mut self, item: &'ast syn::ImplItemFn) {
        let konst = item.sig.constness.is_some();
        if konst {
            self.const_depth += 1;
        }
        self.with_loop_barrier(|c| syn::visit::visit_impl_item_fn(c, item));
        if konst {
            self.const_depth -= 1;
        }
    }

    fn visit_item_const(&mut self, item: &'ast syn::ItemConst) {
        self.const_depth += 1;
        syn::visit::visit_item_const(self, item);
        self.const_depth -= 1;
    }

    fn visit_item_static(&mut self, item: &'ast syn::ItemStatic) {
        self.const_depth += 1;
        syn::visit::visit_item_static(self, item);
        self.const_depth -= 1;
    }

    fn visit_expr_const(&mut self, node: &'ast syn::ExprConst) {
        self.const_depth += 1;
        syn::visit::visit_expr_const(self, node);
        self.const_depth -= 1;
    }

    fn visit_expr_closure(&mut self, node: &'ast syn::ExprClosure) {
        self.with_loop_barrier(|c| syn::visit::visit_expr_closure(c, node));
    }

    fn visit_expr_async(&mut self, node: &'ast syn::ExprAsync) {
        self.with_loop_barrier(|c| syn::visit::visit_expr_async(c, node));
    }

    fn visit_item_mod(&mut self, item: &'ast syn::ItemMod) {
        let test = is_test_attr(&item.attrs);
        if test {
            self.test_depth += 1;
        }
        syn::visit::visit_item_mod(self, item);
        if test {
            self.test_depth -= 1;
        }
    }

    fn visit_expr_for_loop(&mut self, node: &'ast syn::ExprForLoop) {
        let start = node.for_token.span.start();
        let variable = match Self::local_ident(&node.pat) {
            Ok(Some(ident)) => Some(ident.ident.to_string()),
            _ => None,
        };
        let body_start = node.body.brace_token.span.open().byte_range().end;
        self.push_loop(start.line, start.column + 1, variable, body_start);
        syn::visit::visit_expr_for_loop(self, node);
        self.pop_loop();
    }

    fn visit_expr_while(&mut self, node: &'ast syn::ExprWhile) {
        let start = node.while_token.span.start();
        let variable = first_ident(&node.cond);
        let body_start = node.body.brace_token.span.open().byte_range().end;
        self.push_loop(start.line, start.column + 1, variable, body_start);
        syn::visit::visit_expr_while(self, node);
        self.pop_loop();
    }

    fn visit_expr_loop(&mut self, node: &'ast syn::ExprLoop) {
        let start = node.loop_token.span.start();
        let body_start = node.body.brace_token.span.open().byte_range().end;
        self.push_loop(start.line, start.column + 1, None, body_start);
        syn::visit::visit_expr_loop(self, node);
        self.pop_loop();
    }

    fn visit_local(&mut self, local: &'ast syn::Local) {
        syn::visit::visit_local(self, local);
        if self.test_depth > 0 {
            return;
        }
        if self.const_depth > 0 {
            if let Ok(Some(ident)) = Self::local_ident(&local.pat) {
                let name = ident.ident.to_string();
                let range = span_range(ident.ident.span());
                let id = probe_id(self.uri, &range, &name);
                self.probes.push(Probe {
                    probe_id: id,
                    name,
                    supported: false,
                    reason: Some("const context"),
                    range,
                    insertion_byte: None,
                    mode: Mode::Auto,
                });
            }
            return;
        }
        let ident = match Self::local_ident(&local.pat) {
            Ok(Some(ident)) => ident,
            Ok(None) => return,
            Err(reason) => {
                let range = span_range(local.pat.span());
                let id = probe_id(self.uri, &range, "<pattern>");
                self.probes.push(Probe {
                    probe_id: id,
                    name: "<pattern>".into(),
                    supported: false,
                    reason: Some(reason),
                    range,
                    insertion_byte: None,
                    mode: Mode::Auto,
                });
                return;
            }
        };
        let name = ident.ident.to_string();
        let range = span_range(ident.ident.span());
        let id = probe_id(self.uri, &range, &name);
        if local.init.is_none() {
            self.probes.push(Probe {
                probe_id: id,
                name,
                supported: false,
                reason: Some("declaration without initializer"),
                range,
                insertion_byte: None,
                mode: Mode::Auto,
            });
            return;
        }
        let statement_end = local.span().byte_range().end;
        let active = self.active(&id);
        let insertion = format!(
            " crate::atomis_probe!(\"{id}\", {line}, {column}, \"{name}\", &{name});",
            line = range.start_line,
            column = range.start_column,
        );
        if active {
            self.insertions.push((statement_end, insertion));
        }
        self.probes.push(Probe {
            probe_id: id,
            name,
            supported: true,
            reason: None,
            range,
            insertion_byte: if active { Some(statement_end) } else { None },
            mode: if self.auto_inspect {
                Mode::Auto
            } else {
                Mode::Manual
            },
        });
    }

    fn visit_stmt(&mut self, stmt: &'ast syn::Stmt) {
        syn::visit::visit_stmt(self, stmt);
        if self.test_depth > 0 || self.const_depth > 0 {
            return;
        }
        let syn::Stmt::Macro(stmt_macro) = stmt else {
            return;
        };
        let Some(segment) = stmt_macro.mac.path.segments.last() else {
            return;
        };
        let macro_name = segment.ident.to_string();
        if !LOG_MACROS.contains(&macro_name.as_str()) {
            return;
        }
        let fd: u32 = if STDERR_MACROS.contains(&macro_name.as_str()) {
            2
        } else {
            1
        };
        let start = stmt_macro.span().start();
        let line = start.line;
        let column = start.column + 1;
        let end = stmt.span().byte_range().end;
        let enclosing = self.loops.last_mut().and_then(|meta| {
            meta.variable.clone().map(|variable| {
                meta.used = true;
                (meta.line, meta.column, variable, meta.shadow.clone())
            })
        });
        let insertion = match enclosing {
            // `captured &shadow`, never `&variable`: the preview was taken
            // at the top of the body, so a print after the variable moved
            // (consumed, sent down a channel) still compiles and reports.
            Some((lline, lcolumn, variable, shadow)) => format!(
                " crate::atomis_log_loop!({fd}, {file}, {line}, {column}, {lline}, {lcolumn}, \"{variable}\", captured &{shadow});",
                file = self.file_id,
            ),
            None => format!(
                " crate::atomis_log!({fd}, {file}, {line}, {column});",
                file = self.file_id,
            ),
        };
        self.insertions.push((end, insertion));
    }
}

pub fn instrument(
    source: &str,
    uri: &str,
    auto_inspect: bool,
    manual_ids: &[String],
    file_id: u32,
    entry: bool,
) -> Output {
    // syn strips a BOM before parsing, which would shift every byte offset
    // three bytes off the text we splice into. Strip it ourselves and work
    // on the same bytes syn sees; rustc is happy without it.
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    // Exact generated forms only: a user merely *mentioning* atomis_log in
    // a comment or string must not silently turn instrumentation off.
    if source.contains("crate::atomis_probe!(")
        || source.contains("crate::atomis_log!(")
        || source.contains("crate::atomis_log_loop!(")
    {
        return Output {
            generated: Some(source.to_string()),
            probes: Vec::new(),
            parse_diagnostics: Vec::new(),
        };
    }
    let file = match syn::parse_file(source) {
        Ok(file) => file,
        Err(error) => {
            let parse_diagnostics = error
                .into_iter()
                .map(|item| {
                    let start = item.span().start();
                    ParseDiagnostic {
                        message: item.to_string(),
                        line: start.line.max(1),
                        column: start.column + 1,
                    }
                })
                .collect();
            return Output {
                generated: None,
                probes: Vec::new(),
                parse_diagnostics,
            };
        }
    };
    let mut collector = Collector {
        uri,
        file_id,
        auto_inspect,
        manual_ids,
        probes: Vec::new(),
        insertions: Vec::new(),
        loops: Vec::new(),
        loop_counter: 0,
        test_depth: 0,
        const_depth: 0,
    };
    collector.visit_file(&file);

    let mut generated = source.to_string();
    let mut insertions = collector.insertions;
    insertions.sort_by(|left, right| right.0.cmp(&left.0));
    for (byte, text) in insertions {
        if byte <= generated.len() && generated.is_char_boundary(byte) {
            generated.insert_str(byte, &text);
        }
    }
    if entry {
        generated.push_str("\n#[path = \"atomis_runtime.rs\"]\nmod __atomis_runtime;\n");
    }
    debug_assert_eq!(
        source.matches('\n').count() + if entry { 2 } else { 0 },
        generated.matches('\n').count(),
    );
    Output {
        generated: Some(generated),
        probes: collector.probes,
        parse_diagnostics: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "fn main() {\n    let price: i32 = 40;\n    let (a, b) = (1, 2);\n    for i in 0..3 {\n        println!(\"iter {i}\");\n    }\n    eprintln!(\"done\");\n}\n";

    #[test]
    fn probes_simple_lets_and_reports_complex_patterns() {
        let output = instrument(SAMPLE, "file:///main.rs", true, &[], 1, false);
        let generated = output.generated.unwrap();
        assert!(generated.contains("let price: i32 = 40; crate::atomis_probe!("));
        assert!(generated.contains("\"price\", &price);"));
        assert_eq!(SAMPLE.matches('\n').count(), generated.matches('\n').count());
        let supported: Vec<_> = output.probes.iter().filter(|p| p.supported).collect();
        assert_eq!(supported.len(), 1);
        assert_eq!(supported[0].range.start_line, 2);
        let unsupported: Vec<_> = output.probes.iter().filter(|p| !p.supported).collect();
        assert_eq!(unsupported.len(), 1);
        assert_eq!(unsupported[0].reason, Some("destructuring pattern"));
    }

    /// The assertion every instrumenter needs most: whatever was spliced
    /// in, the output is still a Rust program.
    fn must_parse(generated: &str) {
        if let Err(error) = syn::parse_file(generated) {
            panic!("generated output does not parse: {error}\n{generated}");
        }
    }

    #[test]
    fn log_markers_track_loops_and_streams() {
        let output = instrument(SAMPLE, "file:///main.rs", true, &[], 7, false);
        let generated = output.generated.unwrap();
        // The preview is captured at the top of the body and the marker
        // references the capture, so a body that moves `i` still compiles.
        assert!(
            generated.contains("let __atomis_loop_v1 = crate::atomis_loop_capture!(&i);"),
            "{generated}"
        );
        assert!(generated.contains(
            "crate::atomis_log_loop!(1, 7, 5, 9, 4, 5, \"i\", captured &__atomis_loop_v1);"
        ));
        assert!(generated.contains("crate::atomis_log!(2, 7, 7, 5);"));
        must_parse(&generated);
    }

    #[test]
    fn a_loop_that_moves_its_variable_still_instruments() {
        let source = "fn consume(_s: String) {}\nfn main() {\n    let items = vec![String::from(\"a\")];\n    for s in items {\n        consume(s);\n        println!(\"done\");\n    }\n}\n";
        let output = instrument(source, "file:///main.rs", true, &[], 1, false);
        let generated = output.generated.unwrap();
        // The capture precedes the move; the marker never touches `s` again.
        let capture = generated.find("atomis_loop_capture!(&s)").expect("capture");
        let consume = generated.find("consume(s)").expect("consume");
        assert!(capture < consume, "{generated}");
        assert!(!generated.contains("captured &s"), "{generated}");
        must_parse(&generated);
    }

    #[test]
    fn loop_context_stops_at_closures_and_nested_items() {
        let source = "fn main() {\n    for s in [1, 2] {\n        let f = move || {\n            println!(\"inner\");\n        };\n        f();\n        fn nested() {\n            println!(\"deeper\");\n        }\n        nested();\n    }\n}\n";
        let output = instrument(source, "file:///main.rs", true, &[], 1, false);
        let generated = output.generated.unwrap();
        // Markers inside the closure and the nested fn are plain logs: a
        // loop marker there would change the closure's capture set, or
        // reference a variable a nested fn cannot see at all (E0434).
        assert!(!generated.contains("atomis_log_loop"), "{generated}");
        assert!(generated.contains("crate::atomis_log!("));
        // And nothing captures the loop variable nobody printed.
        assert!(!generated.contains("atomis_loop_capture"), "{generated}");
        must_parse(&generated);
    }

    #[test]
    fn const_contexts_are_left_alone() {
        let source = "const fn size() -> usize {\n    let base = 10;\n    base * 2\n}\nstatic TOTAL: usize = {\n    let x = 3;\n    x\n};\nfn main() {\n    let y = size() + TOTAL;\n    println!(\"{y}\");\n}\n";
        let output = instrument(source, "file:///main.rs", true, &[], 1, false);
        let generated = output.generated.unwrap();
        // Probing does I/O; I/O in const evaluation is a compile error.
        assert!(!generated.contains("\"base\""), "{generated}");
        assert!(!generated.contains("\"x\","), "{generated}");
        assert!(generated.contains("\"y\", &y"), "{generated}");
        let base = output.probes.iter().find(|p| p.name == "base").unwrap();
        assert_eq!(base.reason, Some("const context"));
        must_parse(&generated);
    }

    #[test]
    fn a_bom_does_not_shift_every_insertion() {
        let source = "\u{feff}fn main() {\n    let x = 1;\n    println!(\"{x}\");\n}\n";
        let output = instrument(source, "file:///main.rs", true, &[], 1, false);
        let generated = output.generated.unwrap();
        // Pre-fix, syn's offsets were three bytes short of the BOM'd text
        // and every splice landed mid-token.
        assert!(generated.contains("let x = 1; crate::atomis_probe!("), "{generated}");
        must_parse(&generated);
    }

    #[test]
    fn manual_mode_inserts_only_selected_ids() {
        let all = instrument(SAMPLE, "file:///main.rs", true, &[], 1, false);
        let price = all.probes.iter().find(|p| p.name == "price").unwrap();
        let none = instrument(SAMPLE, "file:///main.rs", false, &[], 1, false);
        assert!(none
            .probes
            .iter()
            .all(|probe| probe.insertion_byte.is_none()));
        assert!(!none.generated.unwrap().contains("atomis_probe"));
        let selected = instrument(
            SAMPLE,
            "file:///main.rs",
            false,
            &[price.probe_id.clone()],
            1,
            false,
        );
        assert!(selected.generated.unwrap().contains("\"price\", &price);"));
    }

    #[test]
    fn test_functions_are_not_probed() {
        let source = "#[test]\nfn caso() {\n    let x = 4;\n    assert_eq!(4, x);\n}\n";
        let output = instrument(source, "file:///main.rs", true, &[], 1, false);
        assert!(output.probes.is_empty());
        assert!(!output.generated.unwrap().contains("atomis_probe"));
    }

    #[test]
    fn entry_appends_runtime_module_and_parse_errors_carry_positions() {
        let output = instrument("fn main() {}\n", "file:///main.rs", true, &[], 1, true);
        assert!(output
            .generated
            .unwrap()
            .ends_with("#[path = \"atomis_runtime.rs\"]\nmod __atomis_runtime;\n"));
        let bad = instrument("fn main() {\n    let x = ;\n}\n", "file:///main.rs", true, &[], 1, false);
        assert!(bad.generated.is_none());
        assert_eq!(bad.parse_diagnostics[0].line, 2);
        assert!(bad.parse_diagnostics[0].column >= 12);
    }

    #[test]
    fn instrumented_sources_pass_through_unchanged() {
        let source = "fn main() { let x = 1; crate::atomis_probe!(\"a\", 1, 1, \"x\", &x); }\n";
        let output = instrument(source, "file:///main.rs", true, &[], 1, false);
        assert_eq!(output.generated.as_deref(), Some(source));
        assert!(output.probes.is_empty());
    }
}
