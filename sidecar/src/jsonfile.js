// Crash-safe JSON files for the sidecar's stores (logins.json, visitors.json).
import { writeFile, rename, chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export class JsonFile {
  // content: returns the file's text, read when a write starts.
  constructor(file, content) {
    this.file = file;
    this.content = content;
    this.writing = Promise.resolve();
    this.queued = null;
  }

  // One write at a time, through a temporary file and a rename, readable only by the sidecar's
  // user. Saves made while a write waits for the one before it share that write: it starts after
  // their changes, so it writes them too.
  write() {
    if (this.queued) return this.queued;
    const run = async () => {
      this.queued = null;
      const tmp = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(tmp, this.content(), { mode: 0o600 });
      await rename(tmp, this.file);
      await chmod(this.file, 0o600).catch(() => {});
    };
    const done = this.writing.then(run, run);
    this.queued = done;
    this.writing = done.catch(() => {});
    return done;
  }

  // A file that doesn't parse is moved aside rather than keeping the sidecar from starting.
  async setAside(log, label) {
    const aside = `${this.file}.damaged-${Date.now()}`;
    await rename(this.file, aside).then(
      () => log.warn?.(`${label}: ${this.file} was damaged; moved it to ${aside}`),
      r => log.warn?.(`${label}: ${this.file} was damaged, and moving it aside failed (${r.message}); it's replaced at the next save`),
    );
  }
}
