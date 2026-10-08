import { describe, expect, it } from 'vitest';
import { mountFacts } from './mountinfo';

const INFO = [
  '36 35 98:0 / / rw,relatime - overlay overlay rw',
  '40 36 8:1 / /var/data rw,relatime shared:1 - ext4 /dev/sda1 rw',
  '41 36 8:2 / /mnt/ro ro,relatime - ext4 /dev/sda2 ro',
  '42 36 8:3 / /with\\040space rw - ext4 /dev/sda3 rw',
].join('\n');

describe('mountFacts', () => {
  it('finds a mounted directory', () => {
    expect(mountFacts(INFO, '/var/data')).toEqual({ mounted: true, readOnly: false });
    expect(mountFacts(INFO, '/var/data/')).toEqual({ mounted: true, readOnly: false });
  });
  it('flags read-only mounts', () => {
    expect(mountFacts(INFO, '/mnt/ro')).toEqual({ mounted: true, readOnly: true });
  });
  it('reads escaped spaces', () => {
    expect(mountFacts(INFO, '/with space').mounted).toBe(true);
  });
  it('a plain folder, a sub-folder of a mount, and the root are not mounts', () => {
    expect(mountFacts(INFO, '/tmp/data').mounted).toBe(false);
    expect(mountFacts(INFO, '/var/data/db').mounted).toBe(false);
    expect(mountFacts(INFO, '/').mounted).toBe(false);
    expect(mountFacts('', '/var/data').mounted).toBe(false);
  });
});
