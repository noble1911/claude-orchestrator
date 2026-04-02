use std::sync::Arc;

use crate::database::Database;
use crate::AppState;

pub fn reset_agent_claude_session(
    app_state: &Arc<AppState>,
    db: &Database,
    session_id: &str,
    agent_id: &str,
) {
    {
        let mut agents = app_state.agents.write();
        if let Some(agent) = agents.get_mut(agent_id) {
            agent.claude_session_id = None;
        }
    }
    let _ = db.clear_session_claude_id(session_id);
}
