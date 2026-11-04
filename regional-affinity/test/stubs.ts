import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Stand-ins for the commands a shell script calls, so a test can run cleanup.sh or the Makefile for
 * real without AWS access. The stubs of one scenario are the files of a directory under test/stubs/;
 * `makeStubs` copies them into a fresh temporary directory that goes first on PATH. Each stub appends
 * its calls to `calls` in that directory and reads its scenario from files there, which the test
 * writes with `put`.
 */
export interface Stubs {
  readonly dir: string;
  /** Every line the stubs logged, in order. */
  calls(): string[];
  /** Write a scenario file (or any other file the stubs read) under the stub directory. */
  put(relative: string, content: string): void;
  /** Run a command with the stubs first on PATH and a minimal environment. */
  run(command: string, args: string[], options?: { cwd?: string; env?: Record<string, string> }): {
    status: number | null; output: string;
  };
  cleanup(): void;
}

export function makeStubs(scenario: 'cleanup' | 'make' | 'none'): Stubs {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-stubs-'));
  if (scenario !== 'none') {
    const source = path.join(__dirname, 'stubs', scenario);
    for (const name of fs.readdirSync(source)) {
      // 0755 here, so the stubs work from a checkout that lost the executable bit.
      fs.writeFileSync(path.join(dir, name), fs.readFileSync(path.join(source, name)), { mode: 0o755 });
    }
  }
  return {
    dir,
    put: (relative, content) => {
      const file = path.join(dir, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    },
    calls: () => {
      const log = path.join(dir, 'calls');
      return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    },
    run: (command, args, options = {}) => {
      const result = spawnSync(command, args, {
        cwd: options.cwd,
        encoding: 'utf8',
        timeout: 60_000,
        // Nothing of the developer's environment (AWS_PROFILE, PROJECT, REGION ...) leaks into the script.
        env: { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}`, HOME: dir, STUB_DIR: dir, ...options.env },
      });
      return { status: result.status, output: `${result.stdout}${result.stderr}` };
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
