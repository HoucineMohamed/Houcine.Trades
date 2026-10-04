import type { Db } from '@/data/client';
import { getOwner } from '@/data/auth';
import { checkPassword } from '@/domain/auth/policy';
import { totpQr } from '@/auth/totp';
import {
  createOwner,
  OwnerExistsError,
  OwnerMissingError,
  PasswordPolicyError,
  resetOwner,
  type AuthOptions,
  type EnrolmentResult,
} from '@/auth/service';
import { AuthEnvError } from '@/auth/env';

/**
 * The owner set-up and reset flows, separated from the terminal so they can be tested.
 * Nothing here ever prints the password. The authenticator secret and the recovery codes are
 * printed once and never written anywhere else.
 */

export interface Io {
  readSecret(prompt: string): Promise<string>;
  readLine(prompt: string): Promise<string>;
  print(line?: string): void;
}

const MAX_ATTEMPTS = 3;

/** Asks for a new password twice and checks it against the policy. Returns null after 3 failures. */
export async function askNewPassword(io: Io): Promise<string | null> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const first = await io.readSecret('New password (at least 12 characters, hidden): ');
    const policy = checkPassword(first);
    if (!policy.ok) {
      for (const p of policy.problems) io.print(`  - ${p}`);
      continue;
    }
    const second = await io.readSecret('Type it again to confirm: ');
    if (first !== second) {
      io.print('  - The two passwords are not the same. Try again.');
      continue;
    }
    return first;
  }
  io.print('Too many attempts. Nothing was changed.');
  return null;
}

export function printEnrolment(io: Io, e: EnrolmentResult): void {
  io.print();
  io.print('==================== AUTHENTICATOR (shown ONCE) ====================');
  io.print('1. Open your authenticator app and add an account by scanning this QR code:');
  io.print();
  io.print(totpQr(e.totpUri));
  io.print('   Or enter this key by hand (type: time-based, 6 digits, 30 seconds):');
  io.print(`   ${e.totpSecret}`);
  io.print(`   Or open this link:  ${e.totpUri}`);
  io.print();
  io.print('==================== RECOVERY CODES (shown ONCE) ===================');
  io.print('2. Write these 10 codes on paper (or save them in a password manager). Each works');
  io.print('   once, together with your password, if you lose your authenticator:');
  io.print();
  for (const code of e.recoveryCodes) io.print(`   ${code}`);
  io.print();
  io.print('They are NOT stored anywhere readable and cannot be shown again.');
  io.print('=====================================================================');
}

/** Returns the process exit code. */
export async function createOwnerFlow(io: Io, db: Db, options: AuthOptions = {}): Promise<number> {
  try {
    if (getOwner(db)) throw new OwnerExistsError();
    io.print('Creating the owner of Houcine.Trades. There is only ever ONE owner.');
    const password = await askNewPassword(io);
    if (password === null) return 1;
    const enrolment = await createOwner(db, password, options);
    printEnrolment(io, enrolment);
    await io.readLine('Press Enter once you have saved both. The screen will then be cleared. ');
    io.print('\u001b[2J\u001b[3J\u001b[H');
    io.print(
      'Done. The owner exists. Start the app and log in with your password and a code from your app.',
    );
    return 0;
  } catch (error) {
    return reportError(io, error);
  }
}

export async function resetOwnerFlow(io: Io, db: Db, options: AuthOptions = {}): Promise<number> {
  try {
    if (!getOwner(db)) throw new OwnerMissingError();
    io.print(
      'RESET the owner: you get a NEW password, a NEW authenticator secret and NEW recovery',
    );
    io.print('codes. The old ones stop working and EVERY logged-in session is ended.');
    const answer = await io.readLine('Type RESET to continue: ');
    if (answer !== 'RESET') {
      io.print('Cancelled. Nothing was changed.');
      return 1;
    }
    const password = await askNewPassword(io);
    if (password === null) return 1;
    const enrolment = await resetOwner(db, password, options);
    printEnrolment(io, enrolment);
    await io.readLine('Press Enter once you have saved both. The screen will then be cleared. ');
    io.print('\u001b[2J\u001b[3J\u001b[H');
    io.print('Done. The owner was reset and all sessions were ended.');
    return 0;
  } catch (error) {
    return reportError(io, error);
  }
}

function reportError(io: Io, error: unknown): number {
  if (
    error instanceof OwnerExistsError ||
    error instanceof OwnerMissingError ||
    error instanceof PasswordPolicyError ||
    error instanceof AuthEnvError
  ) {
    io.print(`Error: ${error.message}`);
    return 1;
  }
  if (
    error instanceof Error &&
    (error.name === 'NotATerminalError' || error.name === 'PromptAbortedError')
  ) {
    io.print(`Error: ${error.message}`);
    return 1;
  }
  throw error;
}
