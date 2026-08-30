pub mod run;

use tokio_util::sync::CancellationToken;

use crate::domain::session::{Session, SessionSettings, Snapshot};
use crate::languages::packs::RunFuture;
use crate::languages::runtime::Events;

/// Boxes this language's runner so the pack can hold it as a plain function
/// pointer; `async fn`s each have their own opaque type and could not.
pub fn boxed_run<'a>(
    session: &'a Session,
    snapshot: &'a Snapshot,
    settings: &'a SessionSettings,
    cancel: CancellationToken,
    events: Events,
) -> RunFuture<'a> {
    Box::pin(run::run(session, snapshot, settings, cancel, events))
}
