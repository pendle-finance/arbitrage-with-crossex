import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const ACTUAL_BEARER = 'deadbeef'.repeat(8);

function source(name: string): string {
  return fs.readFileSync(`${repoRoot}/${name}`, 'utf8');
}

describe('installed browser launchers', () => {
  it('macOS launcher reads api-token at click time instead of compiling a bearer', () => {
    const installer = source('install.sh');

    expect(installer).not.toContain(ACTUAL_BEARER);
    expect(installer).toContain('set apiToken to do shell script "/bin/cat " & quoted form of tokenFile');
    expect(installer).toContain('open location ("http://localhost:$PORT/#token=" & apiToken)');
    expect(installer).toContain('open "$HOME/Applications/$APP_TITLE.app"');
    expect(installer).not.toContain('osacompile -e "do shell script \\"open http://localhost:$PORT');
  });

  it('Windows shortcut points to a click-time token reader instead of a tokenized URL', () => {
    const installer = source('install.ps1');
    const uninstaller = source('uninstall.ps1');

    expect(installer).not.toContain(ACTUAL_BEARER);
    expect(installer).toContain("$tokenFile = Join-Path $PSScriptRoot 'config\\api-token'");
    expect(installer).toContain('$encodedToken = [Uri]::EscapeDataString($apiToken)');
    expect(installer).toContain('Start-Process "http://localhost:__PORT__/#token=$encodedToken"');
    expect(installer).toContain("$shell.Popup($message, 0, 'CrossEx-Boros launcher', 48)");
    expect(installer).toContain('Start-Process "http://localhost:__PORT__/"');
    expect(installer).toContain('$shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$LauncherPath`""');
    expect(installer).toContain('& $LauncherPath');
    expect(installer).not.toContain('[InternetShortcut]');
    expect(uninstaller).toContain("$LauncherPath = Join-Path $Root 'open-app.ps1'");
    expect(uninstaller).toContain("foreach ($extension in @('url', 'lnk'))");
  });
});
