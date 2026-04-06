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

/// Constant-time byte comparison to prevent timing side-channels on secret tokens.
///
/// Returns false immediately if lengths differ — this is safe when both operands
/// are always the same fixed format (e.g. UUID v4, 36 bytes). Do NOT use for
/// variable-length secrets where the length itself is sensitive.
pub fn fixed_length_constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}
