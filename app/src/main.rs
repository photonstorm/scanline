//! The Scanline app (docs/APP.md): the game in Chromium, Scanline's panels beside it.
//!
//! One executable, three parts:
//!
//! - **A Chromium helper** (`--type=…`): CEF's renderer, GPU and utility processes.
//! - **A player** (`--remote-debugging-pipe`): the window for one session. The host starts
//!   it as it starts Chrome, drives the page over the pipe, and names the session it shows
//!   (`--scanline-session`) and where the host is (`--scanline-home`). Everything the panels
//!   show they ask the host for, through the control API, as an agent does.
//! - **A launcher** (anything else, such as a click on the Dock): asks the host for a session
//!   in the app, which starts a player, and leaves.

mod browser;
mod host;
mod launcher;
mod mac;
mod panels;
mod player;
mod theme;

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let helper = argv.iter().any(|arg| arg.starts_with("--type="));
    let piped = argv.iter().any(|arg| arg == "--remote-debugging-pipe");

    if !helper && !piped {
        launcher::run(&argv);
        return;
    }

    let args = cef::args::Args::new();

    // Chromium's helpers run in its sandbox, as Chrome's do: it is entered before anything
    // else is loaded, and lasts as long as the process.
    let _sandbox = helper.then(|| {
        let mut sandbox = cef::sandbox::Sandbox::new();

        sandbox.initialize(args.as_main_args());
        sandbox
    });

    // CEF's framework is loaded at run time on macOS, from inside the bundle.
    let loader = cef::library_loader::LibraryLoader::new(&std::env::current_exe().expect("own path"), helper);

    assert!(loader.load(), "could not load the Chromium Embedded Framework from the app bundle");

    let _ = cef::api_hash(cef::sys::CEF_API_VERSION_LAST, 0);

    let mut app = browser::ScanlineApp::new();
    let code = cef::execute_process(Some(args.as_main_args()), Some(&mut app), std::ptr::null_mut());

    if code >= 0 {
        std::process::exit(code);
    }

    mac::make_application_chromium_compatible();
    player::run(args, app, player::Options::from(&argv));

    drop(loader);
}
