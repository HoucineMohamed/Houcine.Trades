/**
 * Is a directory a real mount (a persistent disk) and writable? Reads the text of
 * /proc/self/mountinfo. Pure: the caller reads the file. A folder on the container's own temporary
 * filesystem is NOT a mount, and data kept there would vanish at the next deploy.
 */

export interface MountFacts {
  mounted: boolean;
  readOnly: boolean;
}

const unescape = (s: string) =>
  s.replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));

const normalise = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

export function mountFacts(mountinfo: string, dir: string): MountFacts {
  const want = normalise(dir);
  let found: MountFacts = { mounted: false, readOnly: false };
  if (want === '/' || want === '') return found; // the root filesystem is never "the disk"
  for (const line of mountinfo.split('\n')) {
    const f = line.trim().split(' ');
    const point = f[4];
    const options = f[5];
    if (point === undefined || options === undefined) continue;
    if (normalise(unescape(point)) !== want) continue;
    // the last matching line is the one on top
    found = { mounted: true, readOnly: options.split(',').includes('ro') };
  }
  return found;
}
