// A job's log file. Two guards, because one CI job once wrote 1.6 GB of
// progress lines on a machine with a few GB free:
//   - lines matching the job's `dropLines` are counted, not written;
//   - past maxBytes nothing more is written, except the last lines, which are
//     added at the end (that is where a failure and the summary are).
// Writes are buffered and flushed at least once a second, so a page tailing
// the log sees it move.
import fs from 'node:fs';
import path from 'node:path';
import { ring } from './parse.mjs';

const mb = n => `${(n / (1024 * 1024)).toFixed(1)} MB`;

export function createLog(file, { dropLines = null, maxBytes = 64 * 1024 * 1024, keepTail = 300 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd = fs.openSync(file, 'w');
  const drop = dropLines ? new RegExp(dropLines) : null;
  const tail = ring(keepTail);
  let buf = '', bytes = 0, dropped = 0, overLines = 0, overBytes = 0;
  const flush = () => {
    if (!buf || fd === null) return;
    try { fs.writeSync(fd, buf); } catch {}
    buf = '';
  };
  const write = s => { buf += s; if (buf.length >= 64 * 1024) flush(); };
  const timer = setInterval(flush, 1000);
  timer.unref();
  return {
    line(l) {
      if (drop && drop.test(l)) { dropped++; return; }
      const len = Buffer.byteLength(l) + 1;
      if (bytes + len > maxBytes) { overLines++; overBytes += len; tail.push(l); return; }
      bytes += len;
      write(l + '\n');
    },
    // Deck's own lines; always written, cap or not.
    note(text) { write(`[deck] ${text}\n`); },
    close() {
      if (fd === null) return;
      clearInterval(timer);
      if (overLines) {
        write(`[deck] the log reached ${mb(maxBytes)}: ${overLines} more lines (${mb(overBytes)}) were left out; the last ${Math.min(overLines, keepTail)} follow\n`);
        for (const l of tail.lines()) write(l + '\n');
      }
      if (dropped) write(`[deck] ${dropped} lines matching /${dropLines}/ were left out of this log\n`);
      flush();
      try { fs.closeSync(fd); } catch {}
      fd = null;
    },
    get stats() { return { bytes, dropped, overLines }; },
  };
}
