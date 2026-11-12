//! Where CEF and GPUI meet on Windows: the browser's window is a child of GPUI's, placed over
//! the rectangle GPUI lays out for the game. The same functions as mac.rs.
//!
//! Written on the Mac on 12 November 2026 and never compiled: docs/HANDOVER.md, section 2a.

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

/// Not built on Windows: pictures of the window are a macOS aid for now.
pub fn snapshot(_view: *mut c_void, _path: &std::path::Path) -> bool {
    false
}
