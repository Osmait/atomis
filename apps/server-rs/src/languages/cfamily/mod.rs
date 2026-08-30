pub mod run;

use tokio_util::sync::CancellationToken;

use crate::domain::session::{Session, SessionSettings, Snapshot};
use crate::languages::packs::RunFuture;
use crate::languages::runtime::Events;

/// C and C++ share a runner and differ only by config, so each gets its own
/// entry point rather than the pack carrying a discriminator.
pub fn boxed_run_c<'a>(
    session: &'a Session,
    snapshot: &'a Snapshot,
    settings: &'a SessionSettings,
    cancel: CancellationToken,
    events: Events,
) -> RunFuture<'a> {
    Box::pin(run::run(session, snapshot, settings, cancel, events, run::C_CONFIG))
}

pub fn boxed_run_cpp<'a>(
    session: &'a Session,
    snapshot: &'a Snapshot,
    settings: &'a SessionSettings,
    cancel: CancellationToken,
    events: Events,
) -> RunFuture<'a> {
    Box::pin(run::run(session, snapshot, settings, cancel, events, run::CPP_CONFIG))
}
