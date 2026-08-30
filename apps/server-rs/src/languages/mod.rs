//! Everything a language brings with it: the toolchain it needs, how a file
//! of it is compiled and run, how its diagnostics and probe output are read,
//! and how a dependency is added.

pub mod deps;
pub mod doctor;
pub mod markers;
pub mod ndjson;
pub mod packs;
pub mod runners;
