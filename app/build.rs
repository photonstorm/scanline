//! On Windows the executable carries the app's own manifest (resources/windows/Scanline.manifest)
//! in place of GPUI's, which lacks the compatibility entry Chromium needs, and its icon.

fn main() {
    #[cfg(target_os = "windows")]
    {
        let script = std::path::Path::new("resources/windows/Scanline.rc");

        for file in ["Scanline.rc", "Scanline.manifest", "Scanline.ico"] {
            println!("cargo:rerun-if-changed=resources/windows/{file}");
        }

        embed_resource::compile(script, embed_resource::NONE).manifest_required().unwrap();
    }
}
