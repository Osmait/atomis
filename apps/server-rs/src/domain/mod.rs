//! What a session is, where its files live, and what it means to run one.
//! Speaks `protocol` for the shapes that reach the wire, and `exec` for the
//! processes; knows nothing about HTTP or WebSockets.

pub mod collab;
pub mod preferences;
pub mod scheduler;
pub mod session;
pub mod workspace;
