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
