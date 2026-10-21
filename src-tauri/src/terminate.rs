//! macOS: AppKit's terminate: asks the shell before it quits.
//!
//! ⌘Q's menu item, the Dock's Quit and a quit Apple Event all call
//! -[NSApplication terminate:]. tao's app delegate has no
//! applicationShouldTerminate:, so they went straight on to
//! applicationWillTerminate: and RunEvent::Exit, where the run loop is over:
//! the window stayed on screen, frozen, while the gateway stopped the tools
//! (a Minecraft server gets 30 s to save, the VM 150 s to shut down).
//!
//! This adds applicationShouldTerminate: to tao's delegate class at runtime,
//! the way Emoton's shell does. It answers NSTerminateLater, which keeps the
//! run loop turning, and the shell replies with
//! replyToApplicationShouldTerminate: once the gateway is down.

use objc2::ffi;
use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
use objc2::{class, msg_send, sel};
use std::sync::OnceLock;
use tauri::AppHandle;

/// What applicationShouldTerminate: answers (NSApplicationTerminateReply).
pub enum Answer {
    Cancel = 0,
    Now = 1,
    Later = 2,
}

static APP: OnceLock<AppHandle> = OnceLock::new();

extern "C-unwind" fn should_terminate(_this: *mut AnyObject, _sel: Sel, _sender: *mut AnyObject) -> usize {
    match APP.get() {
        Some(app) => crate::terminate_requested(app) as usize,
        None => Answer::Now as usize,
    }
}

/// Install the hook. Call once from setup (on the main thread). False when
/// it could not be added: a quit then does all its work in RunEvent::Exit.
pub fn install(app: &AppHandle) -> bool {
    let _ = APP.set(app.clone());
    unsafe {
        let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let delegate: *mut AnyObject = msg_send![ns_app, delegate];
        if delegate.is_null() {
            return false;
        }
        let cls = (*delegate).class() as *const AnyClass as *mut AnyClass;
        let f: extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize = should_terminate;
        let imp: Imp = std::mem::transmute(f);
        // "Q@:@": returns NSUInteger, takes self, _cmd, sender.
        let added: Bool = ffi::class_addMethod(cls, sel!(applicationShouldTerminate:), imp, c"Q@:@".as_ptr());
        // NSApplication may cache which delegate methods exist; setting the
        // delegate again makes it look again.
        let _: () = msg_send![ns_app, setDelegate: delegate];
        added.as_bool()
    }
}

/// Let the window go off the screen at once when it is hidden. With its
/// default animation behaviour AppKit animates it out: measured, it was on
/// screen 0.27 s after orderOut:, and 13 to 43 ms with
/// NSWindowAnimationBehaviorNone. A quitting app's windows just go. Main thread.
pub fn without_animation(window: &tauri::Window) {
    let Ok(ns_window) = window.ns_window() else { return };
    let none: isize = 2; // NSWindowAnimationBehaviorNone
    unsafe {
        let _: () = msg_send![ns_window as *mut AnyObject, setAnimationBehavior: none];
    }
}

/// Answer a pending NSTerminateLater: YES quits, NO stays. Safe from any thread.
pub fn reply(app: &AppHandle, quit: bool) {
    let _ = app.run_on_main_thread(move || unsafe {
        let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let _: () = msg_send![ns_app, replyToApplicationShouldTerminate: Bool::new(quit)];
    });
}
