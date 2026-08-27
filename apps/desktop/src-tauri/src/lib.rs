use std::sync::Mutex;

use tauri::{Manager, RunEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

struct Sidecar(Mutex<Option<CommandChild>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // WebKitGTK crashes with the proprietary NVIDIA driver on Wayland
  // (Error 71, explicit sync); the variable must exist before the webview.
  #[cfg(target_os = "linux")]
  if std::env::var_os("__NV_DISABLE_EXPLICIT_SYNC").is_none() {
    std::env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "1");
  }
  // Same story one layer down: where WebKitGTK cannot allocate its GBM
  // buffers ("Failed to create GBM buffer of size WxH") the window paints
  // nothing at all. Falling back to the plain renderer costs some
  // compositing performance and is the difference between a working app
  // and a white rectangle. Set it yourself to opt back in.
  #[cfg(target_os = "linux")]
  if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
  }

  let app = tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .manage(Sidecar(Mutex::new(None)))
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // Sidecar: the bundled Node server. It picks a free port and announces
      // it on stdout; the window navigates there once it is ready.
      let resources = app
        .path()
        .resolve("resources", tauri::path::BaseDirectory::Resource)?;
      let web_dist = resources.join("web-dist");
      let sidecar = app
        .shell()
        .sidecar("atomis-server")?
        .env("ATOMIS_ROOT", resources.as_os_str())
        .env("ATOMIS_WEB_DIST", web_dist.as_os_str())
        .env("ATOMIS_PORT", "0")
        .env("NODE_ENV", "production");
      let (mut events, child) = sidecar.spawn()?;
      *app.state::<Sidecar>().0.lock().unwrap() = Some(child);

      let handle = app.handle().clone();
      tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
          match event {
            CommandEvent::Stdout(line) => {
              let line = String::from_utf8_lossy(&line);
              if let Some(port) = line.trim().strip_prefix("ATOMIS_LISTENING=") {
                let url = format!("http://127.0.0.1:{port}");
                if let Some(window) = handle.get_webview_window("main") {
                  if let Ok(parsed) = url.parse() {
                    let _ = window.navigate(parsed);
                  }
                }
              } else {
                log::info!(target: "sidecar", "{}", line.trim_end());
              }
            }
            CommandEvent::Stderr(line) => {
              log::warn!(target: "sidecar", "{}", String::from_utf8_lossy(&line).trim_end());
            }
            CommandEvent::Error(message) => {
              log::error!(target: "sidecar", "sidecar error: {message}");
            }
            CommandEvent::Terminated(status) => {
              log::error!(target: "sidecar", "sidecar exited: {status:?}");
            }
            _ => {}
          }
        }
      });
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application");

  app.run(|handle, event| {
    if let RunEvent::Exit = event {
      if let Some(child) = handle.state::<Sidecar>().0.lock().unwrap().take() {
        let _ = child.kill();
      }
    }
  });
}
