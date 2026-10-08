import { describe, expect, it } from 'vitest';
import { dropToDataOwner, type ProcessLike } from './privileges';

function fake(uid: number) {
  const calls: string[] = [];
  let current = uid;
  const proc: ProcessLike = {
    getuid: () => current,
    setuid: (u) => {
      calls.push(`setuid ${u}`);
      current = u;
    },
    setgid: (g) => calls.push(`setgid ${g}`),
    initgroups: (u, g) => calls.push(`initgroups ${u} ${g}`),
  };
  return { proc, calls };
}

describe('dropToDataOwner', () => {
  it('as root, becomes the owner of the data folder (groups and gid first, uid last)', () => {
    const f = fake(0);
    expect(dropToDataOwner('/var/data', f.proc, () => ({ uid: 1000, gid: 1000 }))).toBe('dropped');
    expect(f.calls).toEqual(['initgroups 1000 1000', 'setgid 1000', 'setuid 1000']);
  });
  it('not root: does nothing', () => {
    const f = fake(1000);
    expect(dropToDataOwner('/var/data', f.proc, () => ({ uid: 1000, gid: 1000 }))).toBe('not_root');
    expect(f.calls).toEqual([]);
  });
  it('never "steps down" to root: a root-owned folder is a failure', () => {
    const f = fake(0);
    expect(dropToDataOwner('/var/data', f.proc, () => ({ uid: 0, gid: 0 }))).toBe('failed');
    expect(f.calls).toEqual([]);
  });
  it('a folder that cannot be read, or a failing setuid, is a failure (the script must stop)', () => {
    expect(
      dropToDataOwner('/x', fake(0).proc, () => {
        throw new Error('ENOENT');
      }),
    ).toBe('failed');
    const broken = fake(0);
    broken.proc.setuid = () => {
      throw new Error('EPERM');
    };
    expect(dropToDataOwner('/x', broken.proc, () => ({ uid: 1000, gid: 1000 }))).toBe('failed');
  });
});
