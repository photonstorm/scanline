// The probe and the replay page are built once and embedded in the binary, so a host and
// the scripts it injects are always the same version (06-BUILD-PLAN.md, section 1).

use std::path::Path;

fn main() {
    for (what, path) in [("probe", "../../probe/dist/probe.js"), ("replay page", "../../replay/dist/replay.js")] {
        let file = Path::new(env!("CARGO_MANIFEST_DIR")).join(path);

        println!("cargo:rerun-if-changed={}", file.display());

        if !file.exists() {
            panic!(
                "\n\nThe {what} has not been built: {} is missing.\nRun `npm install` and `npm run build` in the repository root, then build again.\n\n",
                file.display()
            );
        }
    }
}
