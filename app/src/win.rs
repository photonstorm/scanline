//! Where CEF and GPUI meet on Windows: the browser's window is a child of GPUI's, placed over
//! the rectangle GPUI lays out for the game. The same functions as mac.rs.
//!
//! Written on the Mac on 12 November 2026, and built and tested on the PC on 17 November
//! (docs/DEPARTURES.md, "The app on Windows").

use std::ffi::c_void;

use windows_sys::Win32::Foundation::{HWND, RECT};
use windows_sys::Win32::Graphics::Gdi::MapWindowPoints;
use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::SetFocus;
use windows_sys::Win32::UI::WindowsAndMessaging::{GetParent, GetWindowRect, SWP_NOACTIVATE, SWP_NOZORDER, SetWindowPos};

/// Nothing to do on Windows: Chromium's application protocols are a macOS matter.
pub fn make_application_chromium_compatible() {}

/// The browser's parent: GPUI's own window.
pub fn content_view(gpui_view: *mut c_void) -> *mut c_void {
    gpui_view
}

/// A window as CEF names one (its own HWND type), as a plain pointer.
pub fn from_cef(handle: cef::sys::cef_window_handle_t) -> *mut c_void {
    handle.0 as *mut c_void
}

/// A plain pointer to a window, as CEF names one.
pub fn to_cef(view: *mut c_void) -> cef::sys::cef_window_handle_t {
    cef::sys::HWND(view as *mut _)
}

/// The window's scale: physical pixels to one of GPUI's.
fn scale(window: HWND) -> f64 {
    let dpi = unsafe { GetDpiForWindow(window) };

    if dpi == 0 { 1.0 } else { f64::from(dpi) / 96.0 }
}

/// A child window's rectangle in its parent's client area, in physical pixels.
fn rect_in_parent(view: HWND) -> Option<RECT> {
    unsafe {
        let parent = GetParent(view);
        let mut rect = RECT { left: 0, top: 0, right: 0, bottom: 0 };

        if parent.is_null() || GetWindowRect(view, &mut rect) == 0 {
            return None;
        }

        MapWindowPoints(std::ptr::null_mut(), parent, &mut rect as *mut RECT as *mut _, 2);

        Some(rect)
    }
}

/// Place `view` in its parent at a rectangle given from the parent's top left, in GPUI's
/// (logical) pixels.
pub fn place(view: *mut c_void, x: f64, y: f64, width: f64, height: f64) {
    if view.is_null() {
        return;
    }

    let view = view as HWND;
    let parent = unsafe { GetParent(view) };

    if parent.is_null() {
        return;
    }

    let s = scale(parent);
    let wanted = RECT {
        left: (x * s).round() as i32,
        top: (y * s).round() as i32,
        right: ((x + width.max(1.0)) * s).round() as i32,
        bottom: ((y + height.max(1.0)) * s).round() as i32,
    };

    if let Some(now) = rect_in_parent(view) {
        if (now.left, now.top, now.right, now.bottom) == (wanted.left, wanted.top, wanted.right, wanted.bottom) {
            return;
        }
    }

    unsafe {
        SetWindowPos(
            view,
            std::ptr::null_mut(),
            wanted.left,
            wanted.top,
            wanted.right - wanted.left,
            wanted.bottom - wanted.top,
            SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
}

/// Give `view` the keyboard.
pub fn focus(view: *mut c_void) {
    if !view.is_null() {
        unsafe {
            SetFocus(view as HWND);
        }
    }
}

/// A child window's rectangle in its parent, for the snapshot's note: [x, y, width, height].
pub fn frame(view: *mut c_void) -> Option<[f64; 4]> {
    if view.is_null() {
        return None;
    }

    let rect = rect_in_parent(view as HWND)?;

    Some([f64::from(rect.left), f64::from(rect.top), f64::from(rect.right - rect.left), f64::from(rect.bottom - rect.top)])
}

/// Holds the cursor for a game that has taken the pointer, or lets it go. On Windows, hidden
/// only: Windows has no call that parts the cursor from the mouse as macOS does, so it still
/// moves, and stops at the edge of the screen.
pub fn hold_pointer(hold: bool) {
    static HELD: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

    if HELD.swap(hold, std::sync::atomic::Ordering::Relaxed) != hold {
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::ShowCursor(if hold { 0 } else { 1 });
        }
    }
}

/// The person's desktop, wherever Windows keeps it (OneDrive moves it, for one).
pub fn desktop() -> Option<std::path::PathBuf> {
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::{FOLDERID_Desktop, KF_FLAG_DEFAULT, SHGetKnownFolderPath};

    unsafe {
        let mut path: *mut u16 = std::ptr::null_mut();
        let found = SHGetKnownFolderPath(&FOLDERID_Desktop, KF_FLAG_DEFAULT as _, std::ptr::null_mut(), &mut path) == 0 && !path.is_null();
        let desktop = found.then(|| {
            let length = (0..).take_while(|&at| *path.add(at) != 0).count();

            std::path::PathBuf::from(String::from_utf16_lossy(std::slice::from_raw_parts(path, length)))
        });

        CoTaskMemFree(path as *const c_void);
        desktop
    }
}

/// The local date and time as the Mac names its screenshots: 2026-11-12 at 14.03.27.
pub fn local_stamp() -> Option<String> {
    let mut now: windows_sys::Win32::Foundation::SYSTEMTIME = unsafe { std::mem::zeroed() };

    unsafe { windows_sys::Win32::System::SystemInformation::GetLocalTime(&mut now) };

    Some(format!("{:04}-{:02}-{:02} at {:02}.{:02}.{:02}", now.wYear, now.wMonth, now.wDay, now.wHour, now.wMinute, now.wSecond))
}

/// Writes a PNG of the window `view` is (its client area, as the window itself draws it, with
/// Direct3D's content). False if the system would not give one.
pub fn snapshot(view: *mut c_void, path: &std::path::Path) -> bool {
    use windows_sys::Win32::Graphics::Gdi::{
        BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleBitmap, CreateCompatibleDC, DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC,
        SelectObject,
    };
    use windows_sys::Win32::Storage::Xps::{PW_CLIENTONLY, PrintWindow};
    use windows_sys::Win32::UI::WindowsAndMessaging::GetClientRect;

    // PW_RENDERFULLCONTENT: what Direct3D and DirectComposition draw, not only GDI's part.
    const RENDER_FULL_CONTENT: u32 = 2;

    if view.is_null() {
        return false;
    }

    let window = view as HWND;

    unsafe {
        let mut rect = RECT { left: 0, top: 0, right: 0, bottom: 0 };

        if GetClientRect(window, &mut rect) == 0 {
            return false;
        }

        let (width, height) = (rect.right - rect.left, rect.bottom - rect.top);

        if width <= 0 || height <= 0 {
            return false;
        }

        let screen = GetDC(window);
        let memory = CreateCompatibleDC(screen);
        let bitmap = CreateCompatibleBitmap(screen, width, height);
        let previous = SelectObject(memory, bitmap);
        let printed = PrintWindow(window, memory, PW_CLIENTONLY | RENDER_FULL_CONTENT) != 0;

        // The bitmap is read once it is no longer selected into a device context.
        SelectObject(memory, previous);

        let mut info: BITMAPINFO = std::mem::zeroed();

        info.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            // Negative: rows from the top down.
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..std::mem::zeroed()
        };

        let mut pixels = vec![0u8; width as usize * height as usize * 4];
        let read = GetDIBits(screen, bitmap, 0, height as u32, pixels.as_mut_ptr().cast(), &mut info, DIB_RGB_COLORS) == height;

        DeleteObject(bitmap);
        DeleteDC(memory);
        ReleaseDC(window, screen);

        if !printed || !read {
            return false;
        }

        // Blue, green, red and an unused byte, to red, green, blue and opaque.
        for pixel in pixels.chunks_exact_mut(4) {
            pixel.swap(0, 2);
            pixel[3] = 255;
        }

        image::save_buffer(path, &pixels, width as u32, height as u32, image::ColorType::Rgba8).is_ok()
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_desktop_is_a_folder_that_exists() {
        assert!(super::desktop().is_some_and(|desktop| desktop.is_dir()));
    }

    #[test]
    fn the_stamp_is_written_as_the_mac_writes_it() {
        let stamp = super::local_stamp().unwrap();

        assert_eq!(stamp.len(), "2026-11-12 at 14.03.27".len(), "{stamp}");
        assert_eq!(&stamp[10..14], " at ", "{stamp}");
        assert!(stamp[..4].parse::<u32>().is_ok_and(|year| year >= 2026), "{stamp}");
    }
}
