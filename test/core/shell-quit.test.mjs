import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The native shell is Rust and has no test harness here, so this guards the
// lines its quit depends on. The behaviour itself is proved on a built
// bundle by scripts/check-quit.mjs.
//
// ⌘Q, the Dock's Quit and a quit Apple Event all go through AppKit's
// terminate:, which tao reports only as LoopDestroyed, i.e. RunEvent::Exit.
// RunEvent::ExitRequested fires only when the last window closes. A hook on
// ExitRequested alone let ⌘Q leave the gateway and every tool running, owned
// by launchd (2026-10-12 for eight days, again 2026-10-21).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const code = file => fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', file), 'utf8')
  .replace(/\/\/.*$/gm, ''); // code only: a comment naming the hook does not count
const main = code('main.rs');
// A top-level fn, up to its closing brace in column 0.
const fn = name => {
  const i = main.indexOf(`\nfn ${name}(`);
  assert.ok(i >= 0, `main.rs has fn ${name}`);
  return main.slice(i, main.indexOf('\n}\n', i));
};

test('the run loop shuts down on RunEvent::Exit', () => {
  const run = main.slice(main.lastIndexOf('.run(|'));
  assert.ok(run.length < main.length, 'main.rs has a .run(|app, event| ...) closure');
  const arm = /if let tauri::RunEvent::Exit = event \{([\s\S]*?)\n {12}\}/.exec(run);
  assert.ok(arm, 'the closure matches RunEvent::Exit (ExitRequested never fires on ⌘Q)');
  assert.match(arm[1], /shut_down\(app\)/, 'and shuts down there');
});

test('the shutdown stops the gateway, once', () => {
  const body = fn('shut_down');
  assert.match(body, /\.shutdown\.call_once\(/, 'once, whichever way out comes first; a second caller waits for it');
  assert.match(body, /stop_gateway\(/, 'the gateway this app spawned');
  assert.match(body, /stop_all_tools\(\)/, 'or an adopted gateway\'s tools');
});

// terminate: comes before RunEvent::Exit, while the run loop still turns: the
// window can go at once, and the gateway is stopped off the main thread. In
// Exit the window stayed on screen, frozen, until the slowest tool was done.
test('terminate: hides the window and stops the gateway off the main thread', () => {
  const setup = main.slice(main.indexOf('.setup(|app|'), main.indexOf('.build(tauri::generate_context!())'));
  assert.match(setup, /terminate::install\(/, 'setup adds applicationShouldTerminate: to the app delegate');
  const body = fn('terminate_requested');
  assert.match(body, /\.hide\(\)[\s\S]*std::thread::spawn\(move \|\| \{\s*shut_down\(&app\);\s*terminate::reply\(&app, true\);/,
    'the window is hidden first, then a thread stops everything and lets the quit go ahead');
  assert.match(body, /terminate::without_animation\([\s\S]*?\.hide\(\)/,
    'without AppKit\'s fade, which kept it on screen 0.27 s longer');
  assert.match(body, /terminate::Answer::Later\s*$/, 'and terminate: is told to wait for that');
  const hook = code('terminate.rs');
  assert.match(hook, /class_addMethod\(cls, sel!\(applicationShouldTerminate:\)/, 'terminate.rs adds the method');
  assert.match(hook, /crate::terminate_requested\(app\)/, 'which asks terminate_requested');
});

test('the sidecar leads a process group of its own', () => {
  const spawn = main.slice(main.indexOf('fn ensure_gateway'), main.indexOf('fn dirs_home'));
  assert.match(spawn, /Command::new\(&sidecar\)[\s\S]*?\.process_group\(0\)[\s\S]*?\.spawn\(\)/,
    'quitting kills that group, so the sidecar must not share the app\'s');
});
