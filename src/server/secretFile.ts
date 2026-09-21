/**
 * Owner-only permissions for the files that hold a live-money secret, on every
 * platform the terminal runs on.
 *
 * On POSIX the mode bits passed to mkdir/writeFile/chmod do the job. On Windows
 * they are SILENTLY IGNORED — Node maps chmod to nothing more than the read-only
 * attribute — so a `.env` containing Gate API keys would simply inherit whatever
 * ACL its parent directory has. Under %LOCALAPPDATA% that is the user plus
 * SYSTEM and (depending on the machine) local Administrators; in a source
 * checkout it is whatever the containing folder allows, which on a shared or
 * domain-joined PC can be considerably wider.
 *
 * So on Windows we set the ACL explicitly with icacls: strip inheritance and
 * grant full control to the current user only.
 *
 * Every call is best-effort and never throws: this hardens a file, it must never
 * be the reason the server refuses to start or a credential save fails.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The current user's SID. Names are not safe to grant against: USERNAME can fail
 * to resolve on a domain-joined machine, a renamed account, or a localised
 * Windows - and a failed grant AFTER inheritance has been stripped leaves an
 * empty DACL that locks out even the owner. `whoami /user` gives the SID, which
 * always resolves, and `*S-1-...` is icacls's own syntax for it.
 */
function currentWindowsSid(): string | null {
  try {
    const out = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const m = out.match(/"(S-1-[\d-]+)"/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Restrict `target` (file or directory) to its owner.
 *
 * Order matters and is the whole point: grant FIRST, drop inheritance only once
 * the grant has succeeded, then verify the result is still readable/writable and
 * restore Windows defaults if it is not. Doing it the obvious way round --
 * `/inheritance:r` before `/grant` -- is exactly what left the data directory
 * with an empty DACL, so the server could not open its own SQLite ledger
 * (SQLITE_CANTOPEN) with nothing to explain why. A slightly wider ACL is
 * recoverable; a folder nobody can open is not.
 */
export function restrictToOwner(target: string): void {
  try {
    if (!fs.existsSync(target)) return;
    // Read at CALL time, not module load: tests force the Windows branch.
    if (process.platform !== 'win32') {
      fs.chmodSync(target, fs.statSync(target).isDirectory() ? 0o700 : 0o600);
      return;
    }
    const sid = currentWindowsSid();
    if (!sid) return; // cannot name the grantee safely - leave the ACL alone
    const isDir = fs.statSync(target).isDirectory();
    const icacls = (args: string[]): void => {
      execFileSync('icacls', [target, ...args], { stdio: 'ignore', windowsHide: true });
    };

    // (OI)(CI) are INHERITANCE flags: correct on a directory, meaningless on a
    // file. Granting them to a directory is also what lets the files created
    // inside it (.env, disclaimer.json) inherit the same owner-only access
    // without ever touching them individually - which matters, because applying
    // ACLs recursively to files that already exist is how the data directory's
    // SQLite ledger ended up unopenable.
    icacls(['/grant:r', isDir ? `*${sid}:(OI)(CI)F` : `*${sid}:(F)`]);
    icacls(['/inheritance:r']);

    // Prove we did not just lock ourselves out - of this path AND, for a
    // directory, of what is already inside it.
    //
    // By really OPENING the files, the way the app will. fs.accessSync was
    // useless here and worse than useless: on Windows it maps to _waccess,
    // which tests only the read-only ATTRIBUTE and never evaluates the DACL —
    // so the empty-DACL lockout this check exists to catch sailed straight
    // past it, while any read-only file sitting in the config dir tripped it
    // and (via the old recursive `/reset /t /c`) reverted the protection on
    // every single boot, silently. A real open goes through the security
    // reference monitor; the reset below is scoped to this path only, and it
    // says so out loud. Read-only-attributed entries are SKIPPED: they throw
    // on an r+ open whatever the ACL says, so they are not evidence.
    const probeOpen = (p: string): void => fs.closeSync(fs.openSync(p, 'r+'));
    const writable = (p: string): boolean => (fs.statSync(p).mode & 0o200) !== 0;
    try {
      if (isDir) {
        const probe = path.join(target, `.probe-${process.pid}`);
        fs.writeFileSync(probe, 'x');
        probeOpen(probe); // re-open, not just create: that is what SQLite does
        fs.unlinkSync(probe);
        for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          const p = path.join(target, entry.name);
          if (writable(p)) probeOpen(p);
        }
      } else if (writable(target)) {
        probeOpen(target);
      }
    } catch (err) {
      console.warn(
        `[secretFile] ${target} is not usable after tightening its permissions — restoring inherited access for it (${(err as Error).message})`,
      );
      icacls(['/reset']); // this path only: no /t, per install.ps1's own reasoning
    }
  } catch {
    /* best-effort: never block startup or a credential write on a permissions call */
  }
}

export function writeOwnerOnlyJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  restrictToOwner(tmp);
  fs.renameSync(tmp, filePath);
}

export function readOwnerJson<T>(filePath: string, validate: (raw: unknown) => T | null): T | null {
  try {
    return validate(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return null;
  }
}
