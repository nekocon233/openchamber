import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export type DesktopUser = { uid: number; gid: number; home: string; name: string };
export type DesktopEnvironment = {
  platform: string;
  binaries: { virtual: string | null; password: string | null; desktop: string | null; dbus: string | null };
};

export const INSTALL_COMMANDS = {
  debian: 'sudo apt install tigervnc-standalone-server tigervnc-tools openbox xterm dbus-x11',
  fedora: 'sudo dnf install tigervnc-server tigervnc-server-minimal openbox xterm dbus-x11',
  arch: 'sudo pacman -S tigervnc openbox xterm dbus',
};

const findBinary = async (names: string[], searchPath = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'): Promise<string | null> => {
  for (const name of names) for (const directory of searchPath.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try { await fs.access(candidate, fs.constants.X_OK); return candidate; } catch { /* Try the next installed name. */ }
  }
  return null;
};

/** Distribution launchers may daemonize; only native VNC servers remain in the owned process group. */
export const findVncBinary = async (names: string[], searchPath?: string): Promise<string | null> => {
  for (const name of names) {
    const binary = await findBinary([name], searchPath);
    if (!binary) continue;
    const file = await fs.open(binary, 'r');
    try {
      const header = Buffer.alloc(4);
      await file.read(header, 0, 4, 0);
      if (header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return binary;
    } finally { await file.close(); }
  }
  return null;
};

export const inspectEnvironment = async (): Promise<DesktopEnvironment> => {
  if (process.platform !== 'linux') return { platform: process.platform, binaries: { virtual: null, password: null, desktop: null, dbus: null } };
  const [virtual, password, desktop, dbus] = await Promise.all([
    findVncBinary(['Xtigervnc', 'Xvnc']),
    findBinary(['tigervncpasswd', 'vncpasswd']),
    findBinary(['xfce4-session', 'startlxqt', 'openbox-session', 'openbox', 'fluxbox', 'icewm-session']),
    findBinary(['dbus-run-session']),
  ]);
  return { platform: process.platform, binaries: { virtual, password, desktop, dbus } };
};

export const currentUser = (): DesktopUser => {
  const user = os.userInfo();
  return { uid: user.uid, gid: user.gid, name: user.username, home: user.homedir };
};
