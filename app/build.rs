//! On Windows the executable carries the app's own manifest (resources/windows/Scanline.manifest)
//! in place of GPUI's, which lacks the compatibility entry Chromium needs.

fn main() {
    #[cfg(target_os = "windows")]
    {
        let manifest = std::path::Path::new("resources/windows/Scanline.manifest");
        let script = std::path::Path::new("resources/windows/Scanline.rc");

        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rerun-if-changed={}", script.display());

        embed_resource::compile(script, embed_resource::NONE).manifest_required().unwrap();
    }
}
