// A mini Redis: an in-memory key-value store that logs every write to a
// file, and replays (then compacts) that log the next time it starts.
// Press Run and type commands under the output: SET name Ada, GET name,
// INCR visits, DEL name, EXISTS name, KEYS, DBSIZE, FLUSHALL, QUIT.
// Run it again: the data is still there. Auto Run replays the Input text.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{self, BufRead, Write};

const LOG: &str = "../redis.aof"; // beside src/, so it is not one of your project files
const COMMANDS: [&str; 8] = ["SET", "GET", "DEL", "EXISTS", "INCR", "KEYS", "DBSIZE", "FLUSHALL"];

/// Rebuilds the store from the log: the cache starts as the file left it.
fn replay(path: &str) -> (BTreeMap<String, String>, usize) {
    let mut store = BTreeMap::new();
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let mut entries = 0;
    for line in text.lines() {
        entries += 1;
        let (op, rest) = line.split_once(' ').unwrap_or((line, ""));
        match op {
            "SET" => {
                let (key, value) = rest.split_once(' ').unwrap_or((rest, ""));
                store.insert(key.to_string(), value.to_string());
            }
            "DEL" => {
                store.remove(rest);
            }
            "FLUSHALL" => store.clear(),
            _ => {}
        }
    }
    (store, entries)
}

struct Db {
    // A BTreeMap keeps its keys sorted: KEYS and compaction need that order.
    store: BTreeMap<String, String>,
    log: File,
}

impl Db {
    fn append(&mut self, entry: &str) {
        writeln!(self.log, "{}", entry).expect("write the log");
    }

    fn execute(&mut self, words: &[&str]) -> String {
        let command = words[0].to_uppercase();
        let args = &words[1..];
        match (command.as_str(), args.len()) {
            ("SET", n) if n >= 2 => {
                let value = args[1..].join(" ");
                self.append(&format!("SET {} {}", args[0], value));
                self.store.insert(args[0].to_string(), value);
                "OK".to_string()
            }
            ("GET", 1) => match self.store.get(args[0]) {
                Some(value) => format!("\"{}\"", value),
                None => "(nil)".to_string(),
            },
            ("DEL", 1) => {
                if self.store.remove(args[0]).is_none() {
                    return "(integer) 0".to_string();
                }
                self.append(&format!("DEL {}", args[0]));
                "(integer) 1".to_string()
            }
            ("EXISTS", 1) => format!("(integer) {}", self.store.contains_key(args[0]) as i32),
            ("INCR", 1) => {
                let current = self.store.get(args[0]).map_or("0", String::as_str);
                let number = match current.parse::<i64>().ok().and_then(|n| n.checked_add(1)) {
                    Some(number) => number,
                    None => return "(error) ERR value is not an integer or out of range".to_string(),
                };
                self.store.insert(args[0].to_string(), number.to_string());
                self.append(&format!("SET {} {}", args[0], number));
                format!("(integer) {}", number)
            }
            ("KEYS", n) if n <= 1 => {
                if self.store.is_empty() {
                    return "(empty array)".to_string();
                }
                let lines: Vec<String> = self
                    .store
                    .keys()
                    .enumerate()
                    .map(|(i, key)| format!("{}) \"{}\"", i + 1, key))
                    .collect();
                lines.join("\n")
            }
            ("DBSIZE", 0) => format!("(integer) {}", self.store.len()),
            ("FLUSHALL", 0) => {
                self.store.clear();
                self.append("FLUSHALL");
                "OK".to_string()
            }
            _ if COMMANDS.contains(&command.as_str()) => {
                format!("(error) ERR wrong number of arguments for '{}'", words[0].to_lowercase())
            }
            _ => format!("(error) ERR unknown command '{}'", words[0]),
        }
    }
}

fn main() {
    let (store, entries) = replay(LOG);
    println!("loaded {} keys ({} log entries) from redis.aof", store.len(), entries);
    // Compaction: the log restarts as one SET per key, then grows a line per write.
    let mut log = File::create(LOG).expect("create the log");
    for (key, value) in &store {
        writeln!(log, "SET {} {}", key, value).expect("write the log");
    }
    let mut db = Db { store, log };

    println!("mini-redis ready: SET GET DEL EXISTS INCR KEYS DBSIZE FLUSHALL QUIT");
    let stdin = io::stdin();
    let mut lines = stdin.lock().lines();
    loop {
        // stdout is a pipe here: a prompt with no newline needs a flush.
        print!("redis> ");
        io::stdout().flush().unwrap();
        let line = match lines.next() {
            Some(Ok(line)) => line,
            _ => break,
        };
        let words: Vec<&str> = line.split_whitespace().collect();
        if words.is_empty() {
            continue;
        }
        if words[0].eq_ignore_ascii_case("QUIT") {
            break;
        }
        println!("{}", db.execute(&words));
    }
    println!("bye");
}
