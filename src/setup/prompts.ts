// Minimal, dependency-free interactive prompts built on node:readline.
//
// Replaces `inquirer`, whose list/rawlist prompts redraw via ANSI cursor
// movement and terminal-capability queries. That rendering hung silently
// (no output, no error) for at least one real terminal — see
// docs/plans/2026-08-27-spam-report-and-block-rules.md for the
// investigation. Plain line-buffered readline has no raw-mode redraw step,
// so there is no equivalent failure mode: worst case, the user sees the
// question text and types an answer.
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const CTRL_C = '\u0003';
const CTRL_D = '\u0004';
const BACKSPACE = '\u007f';

// A single shared interface for the whole process. Creating and closing a
// fresh readline.Interface per question can drop already-buffered stdin
// data (observed with piped/fast input: a question after the first one
// simply never received its answer) — readline owns the stream's line
// buffering, and tearing it down mid-stream loses whatever arrived between
// closes. One long-lived interface avoids that entirely.
let sharedInterface: readline.Interface | null = null;
function getInterface(): readline.Interface {
  if (!sharedInterface) {
    sharedInterface = readline.createInterface({ input, output });
  }
  return sharedInterface;
}

/** Closes the shared readline interface. Call once, when the CLI is done prompting. */
export function closePrompts(): void {
  sharedInterface?.close();
  sharedInterface = null;
}

export async function askText(message: string, defaultValue?: string): Promise<string> {
  const rl = getInterface();
  const suffix = defaultValue ? ` (${defaultValue})` : '';
  const answer = await rl.question(`${message}${suffix} `);
  const trimmed = answer.trim();
  return trimmed.length > 0 ? trimmed : (defaultValue ?? '');
}

export async function askValidated(
  message: string,
  defaultValue: string | undefined,
  validate: (value: string) => true | string,
): Promise<string> {
  for (;;) {
    const value = await askText(message, defaultValue);
    const result = validate(value);
    if (result === true) return value;
    console.log(`  ${result}`);
  }
}

export async function askConfirm(message: string, defaultValue = false): Promise<boolean> {
  const suffix = defaultValue ? 'Y/n' : 'y/N';
  const answer = await askText(`${message} (${suffix})`);
  if (!answer) return defaultValue;
  return /^y/i.test(answer);
}

export async function askChoice<T extends string>(
  message: string,
  choices: Array<{ name: string; value: T }>,
): Promise<T> {
  console.log(message);
  choices.forEach((c, i) => console.log(`  ${i + 1}) ${c.name}`));
  for (;;) {
    const answer = await askText('Enter a number:');
    const idx = parseInt(answer, 10) - 1;
    if (idx >= 0 && idx < choices.length) return choices[idx].value;
    console.log(`  Please enter a number between 1 and ${choices.length}.`);
  }
}

/**
 * Masked password input via raw-mode keypress echo ('*' per character).
 * Falls back to plain (visible) input when the environment genuinely
 * doesn't support raw mode (e.g. piped input) — never hangs waiting for a
 * capability the terminal doesn't have.
 *
 * Deliberately does NOT gate on `input.isTTY`: that flag can be falsy in
 * some real interactive terminals depending on how the process was
 * launched (observed via npx, in a genuinely interactive session where
 * the OS terminal itself was still echoing keystrokes normally) — trusting
 * it caused a real password to be echoed in plaintext instead of masked.
 * Attempting setRawMode directly and catching the failure is the reliable
 * signal; the flag is not.
 */
export function askPassword(message: string): Promise<string> {
  return new Promise((resolve) => {
    output.write(`${message} `);

    // Release the shared line-based interface's grip on stdin before
    // switching to raw mode — its own keypress listeners would otherwise
    // see the same bytes and can end up in a confused internal state.
    // A fresh interface is lazily recreated by the next askText call.
    closePrompts();

    let rawModeOk = true;
    try {
      input.setRawMode(true);
    } catch {
      rawModeOk = false;
    }

    if (!rawModeOk) {
      const rl = getInterface();
      rl.question('').then(resolve);
      return;
    }

    let value = '';
    input.resume();
    input.setEncoding('utf8');

    const cleanup = () => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('data', onData);
    };

    const onData = (char: string) => {
      switch (char) {
        case '\n':
        case '\r':
        case CTRL_D:
          cleanup();
          output.write('\n');
          resolve(value);
          break;
        case CTRL_C:
          cleanup();
          output.write('\n');
          process.exit(130);
          break;
        case BACKSPACE:
        case '\b':
          if (value.length > 0) {
            value = value.slice(0, -1);
            output.write('\b \b');
          }
          break;
        default:
          value += char;
          output.write('*');
      }
    };

    input.on('data', onData);
  });
}
