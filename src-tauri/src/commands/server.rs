// Server commands (pick_folder, get_app_status, start/stop_remote_server, etc.)
// remain in lib.rs because they are tightly coupled to Tauri app APIs (dialog,
// AppHandle, managed state) and are already thin wrappers.
//
// Helper functions (build_server_status, to_workspace_info, to_repository_info,
// detect_remote_connect_host, generate_pairing_code_string) also remain in lib.rs
// as they are used by both Tauri commands and WS handlers within that module.
