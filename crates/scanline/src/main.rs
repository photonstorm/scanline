//! One binary, several modes (02-ARCHITECTURE.md, section 9.1):
//!
//!   scanline serve            the host: holds the browsers, serves the control API
//!   scanline serve --http     the same, and MCP over loopback HTTP with a token
//!   scanline mcp              an MCP server on stdio that relays to the host
//!   scanline <command> …      the same commands from a shell, relayed the same way
//!   scanline stop             stop the host and close its browsers
//!
//! `mcp` and the commands start the host if it is not running. The window is not built yet.

mod cli;
mod control;
mod hotkey;
mod http;

use std::process::ExitCode;

use anyhow::Result;

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();

    match run(args).await {
        Ok(code) => code,
        Err(error) => {
            eprintln!("{error:#}");
            ExitCode::from(1)
        }
    }
}

async fn run(args: Vec<String>) -> Result<ExitCode> {
    match args.first().map(String::as_str) {
        None | Some("--help" | "-h") => {
            cli::say(&format!("{}\n", cli::usage()));
            Ok(ExitCode::SUCCESS)
        }

        Some("--version" | "-V") => {
            cli::say(&format!("scanline {}\n", env!("CARGO_PKG_VERSION")));
            Ok(ExitCode::SUCCESS)
        }

        Some("serve") => {
            // --http adds MCP over loopback HTTP, on the port given or on one the system picks.
            let http = match args.iter().position(|arg| arg == "--http" || arg.starts_with("--http=")) {
                Some(at) => {
                    let given =
                        args[at].strip_prefix("--http=").map(str::to_string).or_else(|| args.get(at + 1).filter(|next| !next.starts_with('-')).cloned());

                    Some(match given {
                        Some(text) => text.parse::<u16>().map_err(|_| anyhow::anyhow!("--http takes a port number, not \"{text}\"."))?,
                        None => 0,
                    })
                }
                None => None,
            };

            control::serve(http).await?;
            Ok(ExitCode::SUCCESS)
        }

        Some("skill" | "skills") => {
            cli::say(&format!("{}\n", cli::skill(&args[1..])?));
            Ok(ExitCode::SUCCESS)
        }

        Some("browser") => {
            cli::say(&format!("{}\n", cli::browser(&args[1..])?));
            Ok(ExitCode::SUCCESS)
        }

        // Run by the host while a person has been asked to press Debug: see hotkey.rs.
        Some("hotkey") => {
            hotkey::run(&args[1..])?;
            Ok(ExitCode::SUCCESS)
        }

        Some("stop") => {
            cli::say(&format!("{}\n", control::stop().await?));
            Ok(ExitCode::SUCCESS)
        }

        Some("mcp") => {
            // One connection to the host for the life of the MCP server, opened on first use,
            // so an agent client that only lists tools never starts a browser host.
            let link = std::sync::Arc::new(tokio::sync::Mutex::new(None::<control::Link>));

            scanline_mcp::serve_stdio(move |command, arguments| {
                let link = link.clone();

                async move {
                    let mut link = link.lock().await;

                    if link.is_none() {
                        *link = Some(control::Link::connect().await?);
                    }

                    let outcome = link.as_mut().unwrap().call(&command, arguments).await;

                    if matches!(&outcome, Err(error) if error.downcast_ref::<control::Dropped>().is_some()) {
                        // The host went away (stopped, or crashed). The next call starts a new one.
                        *link = None;
                    }

                    outcome
                }
            })
            .await?;

            Ok(ExitCode::SUCCESS)
        }

        Some(_) => cli::run(args).await,
    }
}
