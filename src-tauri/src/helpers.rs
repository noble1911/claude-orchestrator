use uuid::Uuid;

/// Maximum number of bytes to read from a workspace file.
pub const MAX_FILE_READ_BYTES: usize = 200_000;

/// Error message returned when a workspace ID is not found in state.
pub const ERR_WORKSPACE_NOT_FOUND: &str = "Workspace not found";

/// Generate a new RFC 3339 timestamp string for the current instant.
pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Generate a new random UUID string.
pub fn new_id() -> String {
    Uuid::new_v4().to_string()
}
