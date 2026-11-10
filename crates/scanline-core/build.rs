// The probe is built once and embedded in the binary, so a host and its probe are always
// the same version (06-BUILD-PLAN.md, section 1).

use std::path::Path;

fn main() {
    let probe = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../probe/dist/probe.js");

    println!("cargo:rerun-if-changed={}", probe.display());

    if !probe.exists() {
        panic!(
            "\n\nThe probe has not been built: {} is missing.\nRun `npm install` and `npm run build:probe` in the repository root, then build again.\n\n",
            probe.display()
        );
    }
}
