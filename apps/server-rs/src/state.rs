//! Shared server state.

use crate::preferences::PreferencesPatch;
use crate::session::SessionManager;
use crate::ws_lsp::LspRegistry;

/// Enough that a burst of settings toggles never makes a live tab miss one;
/// a tab that still falls behind is told by the lag and re-reads.
const PREFERENCES_BACKLOG: usize = 32;

pub struct AppState {
    pub sessions: SessionManager,
    pub lsp_registry: LspRegistry,
    pub port: std::sync::atomic::AtomicU16,
    /// Fans a preferences change out to every open runtime socket, so a
    /// setting changed on one device lands on the others without a reload.
    pub preference_changes: tokio::sync::broadcast::Sender<PreferencesPatch>,
    /// Read once at startup: an empty value means no token is required.
    pub access_token: Option<String>,
}

impl AppState {
    pub fn new() -> Self {
        AppState {
            sessions: SessionManager::new(),
            lsp_registry: LspRegistry::new(),
            port: std::sync::atomic::AtomicU16::new(0),
            preference_changes: tokio::sync::broadcast::channel(PREFERENCES_BACKLOG).0,
            access_token: crate::util::configured_access_token(),
        }
    }
}
