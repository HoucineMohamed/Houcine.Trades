import { createHash } from 'node:crypto';
import { StoreError, type ObjectStore, type StoredObject } from '@/hosting/object-store';

/** An in-memory object store with faults you can switch on. No network. */
export class FakeObjectStore implements ObjectStore {
  readonly objects = new Map<string, Buffer>();
  readonly calls: string[] = [];
  /** Fail the next call of this kind with this code. */
  failNext = new Map<string, StoreError['code']>();
  /** Store only the first N bytes of the next upload (a truncated upload). */
  truncatePutTo: number | null = null;
  /** Flip a byte of every object on download (a corrupted object). */
  corruptOnGet = false;
  /** Forget uploads silently (the provider said OK but kept nothing). */
  dropPuts = false;
  denyAll = false;

  private gate(op: string) {
    this.calls.push(op);
    if (this.denyAll) throw new StoreError('denied');
    const code = this.failNext.get(op);
    if (code) {
      this.failNext.delete(op);
      throw new StoreError(code);
    }
  }
  put(key: string, body: Buffer): Promise<void> {
    try {
      this.gate('put');
    } catch (e) {
      return Promise.reject(e);
    }
    if (this.dropPuts) return Promise.resolve();
    const kept = this.truncatePutTo === null ? body : body.subarray(0, this.truncatePutTo);
    this.truncatePutTo = null;
    this.objects.set(key, Buffer.from(kept));
    return Promise.resolve();
  }
  get(key: string): Promise<Buffer> {
    try {
      this.gate('get');
    } catch (e) {
      return Promise.reject(e);
    }
    const found = this.objects.get(key);
    if (!found) return Promise.reject(new StoreError('not_found'));
    const copy = Buffer.from(found);
    if (this.corruptOnGet && copy.length > 40) copy[40] = (copy[40] ?? 0) ^ 0xff;
    return Promise.resolve(copy);
  }
  list(prefix: string): Promise<StoredObject[]> {
    try {
      this.gate('list');
    } catch (e) {
      return Promise.reject(e);
    }
    return Promise.resolve(
      [...this.objects.entries()]
        .filter(([k]) => k.startsWith(`${prefix}/`))
        .map(([key, v]) => ({ key, size: v.length })),
    );
  }
  delete(key: string): Promise<void> {
    try {
      this.gate('delete');
    } catch (e) {
      return Promise.reject(e);
    }
    this.objects.delete(key);
    return Promise.resolve();
  }
  sha(key: string): string {
    return createHash('sha256')
      .update(this.objects.get(key) ?? Buffer.alloc(0))
      .digest('hex');
  }
}
