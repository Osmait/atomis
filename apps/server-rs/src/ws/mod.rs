//! The two sockets: the runtime channel a session talks over, and the
//! proxy that bridges a language server's stdio to the editor.

pub mod lsp;
pub mod runtime;
