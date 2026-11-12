import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export type DesktopUser = { uid: number; gid: number; home: string; name: string };
export type Display = DesktopUser & { display: string; authority: string | null };
export type DesktopEnvironment = {
  platform: string;
  displays: Display[];
  binaries: { physical: string | null; virtual: string | null; password: string | null; desktop: string | null; dbus: string | null };
};

export const INSTALL_COMMANDS = {
  debian: 'sudo apt install tigervnc-scraping-server tigervnc-standalone-server tigervnc-tools openbox xterm dbus-x11',
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
const findVncBinary = async (names: string[]): Promise<string | null> => {
  for (const name of names) {
    const binary = await findBinary([name]);
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

export const parsePasswd = (text: string): DesktopUser[] => text.split('\n').flatMap((line) => {
  const [name, , uid, gid, , home] = line.split(':');
  return name && home && /^\d+$/.test(uid ?? '') && /^\d+$/.test(gid ?? '') ? [{ name, uid: Number(uid), gid: Number(gid), home }] : [];
});

/** Read only display metadata; environment bytes and X11 cookies never leave the service. */
export const discoverDisplays = async (socketRoot = '/tmp/.X11-unix', procRoot = '/proc', users?: DesktopUser[]): Promise<Display[]> => {
  const accounts = users ?? parsePasswd(await fs.readFile('/etc/passwd', 'utf8'));
  let sockets: string[];
  try { sockets = await fs.readdir(socketRoot); } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  const metadata = [];
  for (const pid of (await fs.readdir(procRoot)).filter((name) => /^\d+$/.test(name))) {
    const root = path.join(procRoot, pid);
    const owner = await fs.stat(root).catch(() => null);
    if (!owner) continue;
    const comm = await fs.readFile(path.join(root, 'comm'), 'utf8').catch(() => '');
    const desktop = /^(gnome-session|gnome-shell|xfce4-session|xfwm4|plasmashell|kwin_x11|openbox|fluxbox|icewm|i3|bspwm|awesome)/.test(comm);
    if (!desktop && !/^(Xorg|Xwayland|Xvfb)/.test(comm)) continue;
    const fields = (await fs.readFile(path.join(root, 'environ'), 'utf8').catch(() => '')).split('\0');
    const environment = Object.fromEntries(fields.filter((entry) => /^(DISPLAY|XAUTHORITY|XDG_SESSION_TYPE)=/.test(entry)).map((entry) => { const i = entry.indexOf('='); return [entry.slice(0, i), entry.slice(i + 1)]; }));
    const args = (await fs.readFile(path.join(root, 'cmdline'), 'utf8').catch(() => '')).split('\0');
    const at = args.indexOf('-auth');
    metadata.push({ uid: owner.uid, desktop, display: environment.DISPLAY?.split('.')[0], authority: environment.XAUTHORITY,
      wayland: environment.XDG_SESSION_TYPE === 'wayland', serverAuthority: at >= 0 ? args[at + 1] : undefined });
  }
  const displays: Display[] = [];
  for (const file of sockets.filter((name) => /^X\d+$/.test(name))) {
    const info = await fs.lstat(path.join(socketRoot, file)).catch(() => null);
    if (!info?.isSocket()) continue;
    const display = `:${file.slice(1)}`;
    const desktops = metadata.filter((entry) => entry.desktop && entry.display === display);
    if (desktops.length > 0 && desktops.every((entry) => entry.wayland)) continue;
    // Xorg can run as root while its login session belongs to another UID.
    const desktopUser = desktops.find((entry) => !entry.wayland && (process.getuid?.() === 0 || entry.uid === process.getuid?.()));
    const user = accounts.find((entry) => entry.uid === (desktopUser?.uid ?? info.uid));
    if (!user || (process.getuid?.() !== 0 && process.getuid?.() !== user.uid)) continue;
    const candidates = metadata.filter((entry) => entry.uid === user.uid && entry.display === display && entry.authority).map((entry) => entry.authority!);
    if (process.env.DISPLAY?.split('.')[0] === display && process.env.XAUTHORITY) candidates.push(process.env.XAUTHORITY);
    candidates.push(`/run/user/${user.uid}/gdm/Xauthority`, path.join(user.home, '.Xauthority'));
    for (const entry of metadata) if (entry.serverAuthority && (entry.uid === info.uid || entry.display === display)) candidates.push(entry.serverAuthority);
    let authority: string | null = null;
    for (const candidate of candidates) {
      const stat = await fs.stat(candidate).catch(() => null);
      if (stat?.isFile() && (stat.uid === user.uid || (stat.mode & 0o004))) { authority = candidate; break; }
    }
    displays.push({ ...user, display, authority });
  }
  return displays.sort((a, b) => Number(a.display.slice(1)) - Number(b.display.slice(1)));
};

export const inspectEnvironment = async (): Promise<DesktopEnvironment> => {
  if (process.platform !== 'linux') return { platform: process.platform, displays: [], binaries: { physical: null, virtual: null, password: null, desktop: null, dbus: null } };
  const [displays, physical, virtual, password, desktop, dbus] = await Promise.all([
    discoverDisplays(), findVncBinary(['X0tigervnc', 'x0vncserver', 'x0tigervncserver', 'x11vnc']), findVncBinary(['Xtigervnc', 'Xvnc']),
    findBinary(['tigervncpasswd', 'vncpasswd']), findBinary(['xfce4-session', 'startlxqt', 'openbox-session', 'openbox', 'fluxbox', 'icewm-session']), findBinary(['dbus-run-session']),
  ]);
  return { platform: process.platform, displays, binaries: { physical, virtual, password, desktop, dbus } };
};

export const currentUser = (): DesktopUser => {
  const user = os.userInfo();
  return { uid: user.uid, gid: user.gid, name: user.username, home: user.homedir };
};
