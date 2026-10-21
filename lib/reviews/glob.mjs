// Risk globs (concept § Routing). Two wildcards and nothing else:
//   *   any run of characters inside one path segment (never a "/")
//   **  any run of characters across segments; "**/" also matches no segment,
//       so "a/**/b" matches "a/b" and "a/x/y/b"
// Every other character is literal, and a glob matches the whole path.
const SPECIAL = /[.+?^${}()|[\]\\]/g;

export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length;) {
    if (glob.startsWith('**', i)) {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 3; } else { re += '.*'; i += 2; }
    } else if (glob[i] === '*') {
      re += '[^/]*';
      i += 1;
    } else {
      re += glob[i].replace(SPECIAL, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchGlob(glob, file) { return globToRegExp(glob).test(file); }

// The changed paths that match any glob, in the order given, each once.
export function riskyPaths(paths, globs) {
  const res = (globs || []).map(globToRegExp);
  const out = [];
  for (const p of paths) if (!out.includes(p) && res.some(re => re.test(p))) out.push(p);
  return out;
}
