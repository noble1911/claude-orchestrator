//! HTTP server for serving the web client static files.
//!
//! Runs alongside the WebSocket server to provide a browser-based
//! remote interface to the Claude Orchestrator.

use axum::Router;
use parking_lot::RwLock;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};

pub struct HttpServer {
    port: u16,
    web_dist_path: PathBuf,
    task: Arc<RwLock<Option<JoinHandle<()>>>>,
}

impl HttpServer {
    pub fn new(port: u16, web_dist_path: PathBuf) -> Self {
        Self {
            port,
            web_dist_path,
            task: Arc::new(RwLock::new(None)),
        }
    }

    pub async fn start(&self) -> Result<(), String> {
        if let Some(handle) = self.task.read().as_ref() {
            if !handle.is_finished() {
                return Ok(());
            }
        }

        let index_path = self.web_dist_path.join("index.html");
        if !self.web_dist_path.exists() {
            return Err(format!(
                "Web client dist directory not found: {}",
                self.web_dist_path.display()
            ));
        }

        let cors = CorsLayer::new()
            .allow_origin(Any)
            .allow_methods(Any)
            .allow_headers(Any);

        let app = Router::new()
            .fallback_service(
                ServeDir::new(&self.web_dist_path)
                    .not_found_service(ServeFile::new(&index_path)),
            )
            .layer(cors);

        let addr = format!("0.0.0.0:{}", self.port);
        let listener = TcpListener::bind(&addr)
            .await
            .map_err(|e| format!("Failed to bind HTTP server: {}", e))?;

        tracing::info!("HTTP server listening on {}", addr);

        let handle = tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, app).await {
                tracing::error!("HTTP server error: {}", e);
            }
        });

        *self.task.write() = Some(handle);
        Ok(())
    }

    pub fn stop(&self) {
        if let Some(handle) = self.task.write().take() {
            handle.abort();
        }
        tracing::info!("HTTP server stopped");
    }
}
