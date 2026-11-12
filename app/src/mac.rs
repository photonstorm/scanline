//! The two places where CEF and GPUI meet in AppKit.
//!
//! 1. Chromium expects the application object to say whether it is inside `sendEvent:`
//!    (`CrAppProtocol`, `CrAppControlProtocol`). GPUI's application class does not, so the
//!    methods are added to it at start-up, before either toolkit makes the application.
//! 2. The browser's view is a sibling of GPUI's view in the window's content view, and is
//!    placed over the rectangle GPUI lays out for the game.

use std::ffi::{CStr, c_char, c_void};
use std::sync::atomic::{AtomicBool, Ordering};

use objc2::ffi;
use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
use objc2::{msg_send, sel};
use objc2_foundation::{NSPoint, NSRect, NSSize};

static HANDLING_SEND_EVENT: AtomicBool = AtomicBool::new(false);
static mut SUPER_SEND_EVENT: Option<Imp> = None;

extern "C" fn is_handling_send_event(_this: *mut AnyObject, _sel: Sel) -> Bool {
    Bool::new(HANDLING_SEND_EVENT.load(Ordering::Relaxed))
}

extern "C" fn set_handling_send_event(_this: *mut AnyObject, _sel: Sel, value: Bool) {
    HANDLING_SEND_EVENT.store(value.as_bool(), Ordering::Relaxed);
}

extern "C" fn send_event(this: *mut AnyObject, sel: Sel, event: *mut AnyObject) {
    let before = HANDLING_SEND_EVENT.swap(true, Ordering::Relaxed);

    unsafe {
        if let Some(imp) = SUPER_SEND_EVENT {
            let imp: extern "C" fn(*mut AnyObject, Sel, *mut AnyObject) = std::mem::transmute(imp);

            imp(this, sel, event);
        }
    }

    HANDLING_SEND_EVENT.store(before, Ordering::Relaxed);
}

/// Teach GPUI's application class Chromium's protocols. Call once, after CEF's framework is
/// loaded (it defines the protocols) and before `gpui::Application::new()`.
pub fn make_application_chromium_compatible() {
    unsafe {
        let class = AnyClass::get(c"GPUIApplication").expect("GPUI registers GPUIApplication when it loads");
        let class_ptr = class as *const AnyClass as *mut AnyClass;
        let base = AnyClass::get(c"NSApplication").expect("AppKit");
        let send = sel!(sendEvent:);

        let method = ffi::class_getInstanceMethod(base, send);

        SUPER_SEND_EVENT = ffi::method_getImplementation(method);

        let add = |sel: Sel, imp: Imp, types: &CStr| {
            ffi::class_addMethod(class_ptr, sel, imp, types.as_ptr());
        };

        add(sel!(isHandlingSendEvent), std::mem::transmute(is_handling_send_event as extern "C" fn(_, _) -> _), c"c@:");
        add(sel!(setHandlingSendEvent:), std::mem::transmute(set_handling_send_event as extern "C" fn(_, _, _)), c"v@:c");
        add(send, std::mem::transmute(send_event as extern "C" fn(_, _, _)), c"v@:@");

        for name in [c"CrAppProtocol", c"CrAppControlProtocol", c"CefAppProtocol"] {
            let protocol = ffi::objc_getProtocol(name.as_ptr() as *const c_char);

            if !protocol.is_null() {
                ffi::class_addProtocol(class_ptr, protocol);
            }
        }
    }
}

/// The window's content view: the parent of GPUI's own view.
pub fn content_view(gpui_view: *mut c_void) -> *mut c_void {
    unsafe {
        let view = &*(gpui_view as *const AnyObject);
        let parent: *mut AnyObject = msg_send![view, superview];

        parent as *mut c_void
    }
}

/// Place `view` in its parent at a rectangle given from the parent's top left, in points.
pub fn place(view: *mut c_void, x: f64, y: f64, width: f64, height: f64) {
    if view.is_null() {
        return;
    }

    unsafe {
        let view = &*(view as *const AnyObject);
        let parent: *mut AnyObject = msg_send![view, superview];

        if parent.is_null() {
            return;
        }

        let parent = &*parent;
        let flipped: Bool = msg_send![parent, isFlipped];
        let bounds: NSRect = msg_send![parent, bounds];
        let top = if flipped.as_bool() { y } else { bounds.size.height - y - height };
        let frame = NSRect::new(NSPoint::new(x, top), NSSize::new(width.max(1.0), height.max(1.0)));
        let current: NSRect = msg_send![view, frame];

        if current != frame {
            // The browser's view must not be resized by AppKit as well.
            let _: () = msg_send![view, setAutoresizingMask: 0usize];
            let _: () = msg_send![view, setFrame: frame];

            // Nor draw outside the game area, whatever Chromium does inside it.
            let responds: Bool = msg_send![view, respondsToSelector: sel!(setClipsToBounds:)];

            if responds.as_bool() {
                let _: () = msg_send![view, setClipsToBounds: Bool::YES];
            }
        }
    }
}

/// Make `view` the window's first responder, so the keyboard goes to it.
pub fn focus(view: *mut c_void) {
    if view.is_null() {
        return;
    }

    unsafe {
        let view = &*(view as *const AnyObject);
        let window: *mut AnyObject = msg_send![view, window];

        if !window.is_null() {
            let _: Bool = msg_send![&*window, makeFirstResponder: view];
        }
    }
}

/// A view's frame in its parent, for the report: [x, y, width, height], y from the bottom.
pub fn frame(view: *mut c_void) -> Option<[f64; 4]> {
    if view.is_null() {
        return None;
    }

    unsafe {
        let view = &*(view as *const AnyObject);
        let frame: NSRect = msg_send![view, frame];

        Some([frame.origin.x, frame.origin.y, frame.size.width, frame.size.height])
    }
}

// ── A picture of the app's own window ─────────────────────────────────────────────────────
//
// For checking the window without anyone at the screen: a process may capture its own
// windows without the Screen Recording permission. CGWindowListCreateImage is looked up at
// run time, as newer SDKs mark it unavailable while the system still has it.

type CgImage = *mut c_void;

#[repr(C)]
#[derive(Clone, Copy)]
struct CgRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[link(name = "ImageIO", kind = "framework")]
unsafe extern "C" {
    fn CGImageDestinationCreateWithURL(url: *const c_void, kind: *const c_void, count: usize, options: *const c_void) -> *mut c_void;
    fn CGImageDestinationAddImage(destination: *mut c_void, image: CgImage, properties: *const c_void);
    fn CGImageDestinationFinalize(destination: *mut c_void) -> bool;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFURLCreateFromFileSystemRepresentation(allocator: *const c_void, path: *const u8, length: isize, directory: bool) -> *const c_void;
    fn CFStringCreateWithCString(allocator: *const c_void, text: *const std::ffi::c_char, encoding: u32) -> *const c_void;
    fn CFRelease(object: *const c_void);
}

unsafe extern "C" {
    fn dlsym(handle: *mut c_void, symbol: *const std::ffi::c_char) -> *mut c_void;
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGAssociateMouseAndMouseCursorPosition(connected: u32) -> i32;
    fn CGDisplayHideCursor(display: u32) -> i32;
    fn CGDisplayShowCursor(display: u32) -> i32;
    fn CGMainDisplayID() -> u32;
}

/// Whether the cursor is held for the game now, so hiding and showing stay paired.
static HELD: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Holds the cursor still and hidden for a game that has taken the pointer (pointer lock), as
/// Chrome does; or lets it go. The mouse's moves still reach the page, as movementX and
/// movementY, while the cursor stays where it is.
pub fn hold_pointer(hold: bool) {
    if HELD.swap(hold, std::sync::atomic::Ordering::Relaxed) == hold {
        return;
    }

    unsafe {
        CGAssociateMouseAndMouseCursorPosition(if hold { 0 } else { 1 });

        if hold {
            CGDisplayHideCursor(CGMainDisplayID());
        } else {
            CGDisplayShowCursor(CGMainDisplayID());
        }
    }
}

/// Writes a PNG of the window `view` is in. False if the system would not give one.
pub fn snapshot(view: *mut c_void, path: &std::path::Path) -> bool {
    if view.is_null() {
        return false;
    }

    unsafe {
        let view = &*(view as *const AnyObject);
        let window: *mut AnyObject = msg_send![view, window];

        if window.is_null() {
            return false;
        }

        let number: isize = msg_send![&*window, windowNumber];
        let create = dlsym(-2isize as *mut c_void, c"CGWindowListCreateImage".as_ptr());

        if create.is_null() {
            return false;
        }

        let create: extern "C" fn(CgRect, u32, u32, u32) -> CgImage = std::mem::transmute(create);
        // CGRectNull, including only this window, ignoring its shadow, at full resolution.
        let image = create(CgRect { x: f64::INFINITY, y: f64::INFINITY, w: 0.0, h: 0.0 }, 1 << 3, number as u32, 1 | (1 << 3));

        if image.is_null() {
            return false;
        }

        let bytes = path.as_os_str().as_encoded_bytes();
        let url = CFURLCreateFromFileSystemRepresentation(std::ptr::null(), bytes.as_ptr(), bytes.len() as isize, false);
        let kind = CFStringCreateWithCString(std::ptr::null(), c"public.png".as_ptr(), 0x0800_0100);
        let destination = CGImageDestinationCreateWithURL(url, kind, 1, std::ptr::null());
        let mut written = false;

        if !destination.is_null() {
            CGImageDestinationAddImage(destination, image, std::ptr::null());
            written = CGImageDestinationFinalize(destination);
            CFRelease(destination);
        }

        CFRelease(kind);
        CFRelease(url);
        CFRelease(image);

        written
    }
}
