//! Sessions that share a persistent workspace.
//!
//! Two devices opening the same workspace get two sessions writing the same
//! files on disk. Nothing connected them, so each one's edits silently
//! replaced the other's: the last keystroke won and the loser was never
//! told. This is what connects them — who else is here, what they changed,
//! and a refusal to accept a write built on a version that has moved on.
//!
//! Scratch sessions have no workspace and never take part: they are private
//! by construction.

use std::collections::{HashMap, HashSet};

use tokio::sync::{broadcast, Mutex};

/// Enough that a burst of keystrokes never makes a peer miss one; a peer
/// that still falls behind is told, and re-reads on its next load.
const BACKLOG: usize = 256;

#[derive(Debug, Clone)]
pub enum WorkspaceChange {
    /// How many sessions are in this workspace, including the recipient.
    Peers { workspace: String, count: usize },
    /// One session accepted an edit; every other session in the workspace
    /// should show it.
    Document {
        workspace: String,
        /// The session that made the edit, so it can skip its own echo.
        origin: String,
        path: String,
        source: String,
        revision: u64,
    },
}

/// A write was built on a revision that is no longer current: someone else
/// changed the workspace in between.
#[derive(Debug, Clone, Copy)]
pub struct Conflict {
    pub current: u64,
}

#[derive(Default)]
struct State {
    peers: HashMap<String, HashSet<String>>,
    /// Bumped by every accepted write. One counter per workspace rather than
    /// per file: it answers "has anything moved since you last looked", which
    /// is the question a stale write needs answered.
    revisions: HashMap<String, u64>,
    /// One writer at a time per workspace — see [`Collab::edit_lock`].
    edit_locks: HashMap<String, std::sync::Arc<Mutex<()>>>,
}

pub struct Collab {
    state: Mutex<State>,
    changes: broadcast::Sender<WorkspaceChange>,
}

impl Collab {
    pub fn new() -> Self {
        Collab {
            state: Mutex::new(State::default()),
            changes: broadcast::channel(BACKLOG).0,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<WorkspaceChange> {
        self.changes.subscribe()
    }

    /// Announces a session and returns the workspace's current revision, so
    /// the client knows what its first write will be built on.
    pub async fn join(&self, workspace: &str, session: &str) -> u64 {
        let (count, revision) = {
            let mut state = self.state.lock().await;
            let peers = state.peers.entry(workspace.to_string()).or_default();
            peers.insert(session.to_string());
            let count = peers.len();
            let revision = *state.revisions.entry(workspace.to_string()).or_insert(0);
            (count, revision)
        };
        self.announce_peers(workspace, count);
        revision
    }

    pub async fn leave(&self, workspace: &str, session: &str) {
        let count = {
            let mut state = self.state.lock().await;
            let Some(peers) = state.peers.get_mut(workspace) else {
                return;
            };
            peers.remove(session);
            let count = peers.len();
            if count == 0 {
                state.peers.remove(workspace);
            }
            count
        };
        self.announce_peers(workspace, count);
    }

    pub async fn peer_count(&self, workspace: &str) -> usize {
        self.state
            .lock()
            .await
            .peers
            .get(workspace)
            .map_or(0, HashSet::len)
    }

    /// The per-workspace write lock. A caller that holds it across
    /// check → persist → record knows the revision it checked is still the
    /// revision when it records: nothing else can bump it in between, so an
    /// edit is never broadcast for a write the store then refuses.
    pub async fn edit_lock(&self, workspace: &str) -> std::sync::Arc<Mutex<()>> {
        let mut state = self.state.lock().await;
        std::sync::Arc::clone(state.edit_locks.entry(workspace.to_string()).or_default())
    }

    /// Whether a write built on `base` would be accepted right now, without
    /// recording or announcing anything.
    pub async fn check_base(&self, workspace: &str, base: Option<u64>) -> Result<(), Conflict> {
        let mut state = self.state.lock().await;
        let current = *state.revisions.entry(workspace.to_string()).or_insert(0);
        match base {
            Some(base) if base != current => Err(Conflict { current }),
            _ => Ok(()),
        }
    }

    /// Accepts an edit if it was built on the current revision, and tells
    /// everyone else about it. `None` for `base` is a client that has not
    /// been told a revision yet, which is trusted rather than blocked — the
    /// point is to catch a stale write, not to gate the first one.
    pub async fn record_edit(
        &self,
        workspace: &str,
        origin: &str,
        path: &str,
        source: &str,
        base: Option<u64>,
    ) -> Result<u64, Conflict> {
        let revision = {
            let mut state = self.state.lock().await;
            let current = state.revisions.entry(workspace.to_string()).or_insert(0);
            if let Some(base) = base {
                if base != *current {
                    return Err(Conflict { current: *current });
                }
            }
            *current += 1;
            *current
        };
        let _ = self.changes.send(WorkspaceChange::Document {
            workspace: workspace.to_string(),
            origin: origin.to_string(),
            path: path.to_string(),
            source: source.to_string(),
            revision,
        });
        Ok(revision)
    }

    fn announce_peers(&self, workspace: &str, count: usize) {
        // Errs when nothing is listening, which is not a failure.
        let _ = self.changes.send(WorkspaceChange::Peers {
            workspace: workspace.to_string(),
            count,
        });
    }
}

impl Default for Collab {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_write_built_on_the_current_revision_is_accepted() {
        let collab = Collab::new();
        let base = collab.join("w", "a").await;
        assert_eq!(base, 0);
        let next = collab
            .record_edit("w", "a", "main.zig", "x", Some(base))
            .await
            .expect("accepted");
        assert_eq!(next, 1);
    }

    #[tokio::test]
    async fn a_write_built_on_a_revision_that_moved_is_refused() {
        let collab = Collab::new();
        let base = collab.join("w", "a").await;
        collab.join("w", "b").await;
        // B writes first; A's pending write was built on what came before.
        collab
            .record_edit("w", "b", "main.zig", "from b", Some(base))
            .await
            .expect("b accepted");
        let refused = collab
            .record_edit("w", "a", "main.zig", "from a", Some(base))
            .await;
        assert!(refused.is_err(), "a stale write must not silently win");
        assert_eq!(refused.unwrap_err().current, 1);
    }

    #[tokio::test]
    async fn a_client_with_no_revision_yet_is_not_blocked() {
        let collab = Collab::new();
        collab.join("w", "a").await;
        collab
            .record_edit("w", "b", "main.zig", "first", Some(0))
            .await
            .expect("accepted");
        collab
            .record_edit("w", "a", "main.zig", "no base", None)
            .await
            .expect("a client that never heard a revision is trusted");
    }

    #[tokio::test]
    async fn peers_are_counted_per_workspace_and_released() {
        let collab = Collab::new();
        collab.join("w", "a").await;
        assert_eq!(collab.peer_count("w").await, 1);
        collab.join("w", "b").await;
        collab.join("other", "c").await;
        assert_eq!(collab.peer_count("w").await, 2);
        assert_eq!(collab.peer_count("other").await, 1);
        collab.leave("w", "a").await;
        assert_eq!(collab.peer_count("w").await, 1);
        collab.leave("w", "b").await;
        assert_eq!(collab.peer_count("w").await, 0);
    }

    #[tokio::test]
    async fn an_edit_reaches_the_others_with_who_made_it() {
        let collab = Collab::new();
        let mut listener = collab.subscribe();
        collab.join("w", "a").await;
        collab
            .record_edit("w", "a", "main.zig", "hello", Some(0))
            .await
            .expect("accepted");
        // The join announcement comes first.
        let mut document = None;
        for _ in 0..4 {
            match listener.try_recv() {
                Ok(WorkspaceChange::Document { origin, source, revision, .. }) => {
                    document = Some((origin, source, revision));
                    break;
                }
                Ok(_) => continue,
                Err(_) => break,
            }
        }
        let (origin, source, revision) = document.expect("the edit was broadcast");
        assert_eq!(origin, "a");
        assert_eq!(source, "hello");
        assert_eq!(revision, 1);
    }
}
