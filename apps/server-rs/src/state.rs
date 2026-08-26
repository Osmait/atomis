//! Shared server state.

use crate::session::SessionManager;
use crate::ws_lsp::LspRegistry;

pub struct AppState {
    pub sessions: SessionManager,
    pub lsp_registry: LspRegistry,
    pub port: std::sync::atomic::AtomicU16,
}

impl AppState {
    pub fn new() -> Self {
        AppState {
            sessions: SessionManager::new(),
            lsp_registry: LspRegistry::new(),
            port: std::sync::atomic::AtomicU16::new(0),
        }
    }
}
