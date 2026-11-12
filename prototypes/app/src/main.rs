//! Stage 0 of docs/APP.md: can a GPUI window hold a real Chromium running a game, and drive it
//! over the DevTools protocol from native controls?
//!
//! One executable plays every part: started with `--type=…` it is one of Chromium's helper
//! processes; without, it is the application.

mod browser;
mod mac;
mod ui;

fn main() {
    let args = cef::args::Args::new();
    let helper = std::env::args().any(|arg| arg.starts_with("--type="));

    // CEF's framework is loaded at run time on macOS, from inside the bundle.
    let loader = cef::library_loader::LibraryLoader::new(&std::env::current_exe().expect("own path"), helper);

    assert!(loader.load(), "could not load the Chromium Embedded Framework from the app bundle");

    let _ = cef::api_hash(cef::sys::CEF_API_VERSION_LAST, 0);

    let mut app = browser::PrototypeApp::new();
    let code = cef::execute_process(Some(args.as_main_args()), Some(&mut app), std::ptr::null_mut());

    if code >= 0 {
        std::process::exit(code);
    }

    mac::make_application_chromium_compatible();
    ui::run(args, app);

    drop(loader);
}
