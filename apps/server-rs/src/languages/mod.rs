//! Everything a language brings with it — the toolchain it needs, how a
//! file of it is compiled and run, how its diagnostics and probe output are
//! read, and how a dependency is added.
//!
//! One `LanguagePack` per language says all of it, so adding a language is
//! adding a folder and one line in `PACKS` rather than an arm in each of
//! seven `match`es.

pub mod cfamily;
pub mod common;
pub mod deps;
pub mod doctor;
pub mod go;
pub mod markers;
pub mod ndjson;
pub mod packs;
pub mod py;
pub mod runtime;
pub mod rust;
pub mod ts;
pub mod zig;
