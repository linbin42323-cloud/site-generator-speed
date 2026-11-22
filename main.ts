// The harness driver: `node /bot/main.ts` on node22. It reads every case from /input/cases.json (a JSON
// array of {id, input}), answers each one alone with run() from solve.js, and writes /output/answers.json:
// a JSON array of the answers, one per case and in the cases' order. Outside a container
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { readFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its work runs under it.
setFlagsFromString('--no-incremental-marking');
// The build is short-lived: skipping TurboFan's background optimisation keeps its compilation CPU
// (counted in the timed run, which is the process's whole CPU time) out of the measurement.
setFlagsFromString('--no-opt');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));

// The answer file, written one case at a time. Each tree's keys and string values are serialized with
// JSON.stringify, so the bytes are exactly JSON.stringify's; the per-case framing avoids one 8 MB rope.
const fd = openSync(join(OUTPUT_DIR, 'answers.json'), 'w');
writeSync(fd, '[');
for (let i = 0; i < answers.length; i++) {
  const tree = answers[i] as Record<string, string>;
  let text = i === 0 ? '{' : ',{';
  let first = true;
  for (const path in tree) {
    if (!first) text += ',';
    first = false;
    text += JSON.stringify(path) + ':' + JSON.stringify(tree[path]);
  }
  writeSync(fd, text + '}');
}
writeSync(fd, ']');
closeSync(fd);
