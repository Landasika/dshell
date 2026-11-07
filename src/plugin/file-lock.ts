import { closeSync, fstatSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'

/** Recover locks left by dead writers without taking a live writer's lock. */
export function acquireFileLock(path: string): () => void {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number
    try {
      fd = openSync(path, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const info = statSync(path)
      let pid: number | undefined
      try {
        const value = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown }
        if (typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid > 0) pid = value.pid
      } catch { /* Older versions created empty locks. */ }
      let stale = pid === undefined && Date.now() - info.mtimeMs > 30_000
      if (pid !== undefined) {
        try { process.kill(pid, 0) }
        catch (probe) { stale = (probe as NodeJS.ErrnoException).code === 'ESRCH' }
      }
      if (!stale || attempt > 0) {
        throw new Error(`configuration is being edited; retry shortly (lock: ${path})`)
      }
      // A competing recovery may already have replaced the lock.
      try {
        const current = statSync(path)
        if (current.ino === info.ino && current.mtimeMs === info.mtimeMs) unlinkSync(path)
      } catch (recovery) {
        if ((recovery as NodeJS.ErrnoException).code !== 'ENOENT') throw recovery
      }
      continue
    }
    const ino = fstatSync(fd).ino
    const release = (): void => {
      try { if (statSync(path).ino === ino) unlinkSync(path) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid })) }
    catch (error) { release(); throw error }
    finally { closeSync(fd) }
    return release
  }
  throw new Error(`could not acquire configuration lock: ${path}`)
}
