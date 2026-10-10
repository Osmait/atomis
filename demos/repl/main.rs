// A tiny calculator REPL: it reads what you type, line by line.
// Press Run, then answer under the output: 2 + 3, sum, help, quit.
// Ctrl+D (end of input) quits too. Auto Run plays the Input text instead.

use std::io::{self, BufRead, Write};

fn evaluate(line: &str) -> Result<f64, &'static str> {
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() != 3 {
        return Err("expected: <number> <op> <number>");
    }
    let a: f64 = parts[0].parse().map_err(|_| "not a number")?;
    let b: f64 = parts[2].parse().map_err(|_| "not a number")?;
    match parts[1] {
        "+" => Ok(a + b),
        "-" => Ok(a - b),
        "*" => Ok(a * b),
        "/" if b == 0.0 => Err("can't divide by zero"),
        "/" => Ok(a / b),
        _ => Err("expected: <number> <op> <number>"),
    }
}

fn main() {
    let mut results: Vec<f64> = Vec::new();
    println!("Tiny calculator. Try 2 + 3, or: help, sum, quit");
    let stdin = io::stdin();
    let mut lines = stdin.lock().lines();
    loop {
        // stdout is a pipe here: a prompt with no newline needs a flush.
        print!("> ");
        io::stdout().flush().unwrap();
        let line = match lines.next() {
            Some(Ok(line)) => line,
            _ => break,
        };
        match line.trim() {
            "quit" => break,
            "" => continue,
            "help" => println!("<number> <op> <number>, with op one of + - * /"),
            "sum" => {
                let total: f64 = results.iter().sum();
                println!("total of {} results: {}", results.len(), total);
            }
            expression => match evaluate(expression) {
                Ok(result) => {
                    results.push(result);
                    println!("{}", result);
                }
                Err(message) => println!("? {}", message),
            },
        }
    }
    println!("bye");
}
