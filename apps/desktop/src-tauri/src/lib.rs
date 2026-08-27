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

      // Sidecar: the bundled server. It announces its port on stdout and
      // the window navigates there once it is ready.
      let resources = app
        .path()
        .resolve("resources", tauri::path::BaseDirectory::Resource)?;
      let web_dist = resources.join("web-dist");
      // The page's origin includes the port, and WebKit keys localStorage
      // by origin — so an ephemeral port would hand the user an empty set
      // of preferences on every launch. Reuse the last port whenever it is
      // still free.
      let data_dir = app.path().app_data_dir()?;
      let _ = std::fs::create_dir_all(&data_dir);
      let port_file = data_dir.join("port");
      let port = std::fs::read_to_string(&port_file)
        .ok()
        .and_then(|saved| saved.trim().parse::<u16>().ok())
        .filter(|port| std::net::TcpListener::bind(("127.0.0.1", *port)).is_ok())
        .unwrap_or(0);
      let sidecar = app
        .shell()
        .sidecar("atomis-server")?
        .env("ATOMIS_ROOT", resources.as_os_str())
        .env("ATOMIS_WEB_DIST", web_dist.as_os_str())
        .env("ATOMIS_PORT", port.to_string())
        // Our exit handler kills the sidecar, but it does not run when we
        // are killed ourselves. Closing this pipe is the one signal that
        // always reaches the server, so it can stop holding the port.
        .env("ATOMIS_EXIT_ON_STDIN_EOF", "1")
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
                // Remember it so the next launch keeps the same origin, and
                // with it every stored preference.
                let _ = std::fs::write(&port_file, port);
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
