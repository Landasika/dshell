/** Minimal, cached Git breadcrumb for the footer (branch, ahead/behind). */
import { execFile } from 'node:child_process'

export interface GitInfo {
  branch: string
  ahead: number
  behind: number
  dirty: boolean
}

/**
 * Read the branch and tracking divergence with one `git status` call. Returns
 * undefined outside a repository, when git is missing, or when the call takes
 * longer than `timeoutMs`; the footer simply omits the segment then.
 */
export function readGitInfo(cwd: string, timeoutMs = 700): Promise<GitInfo | undefined> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, 'status', '--porcelain=v2', '--branch', '--untracked-files=no'],
      { timeout: timeoutMs, maxBuffer: 256 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error !== null) {
          resolve(undefined)
          return
        }
        let branch = ''
        let ahead = 0
        let behind = 0
        let dirty = false
        for (const line of stdout.split('\n')) {
          if (line.startsWith('# branch.head ')) {
            branch = line.slice('# branch.head '.length).trim()
          } else if (line.startsWith('# branch.ab ')) {
            const match = /\+(\d+)\s+-(\d+)/.exec(line)
            if (match !== null) {
              ahead = Number(match[1] ?? 0)
              behind = Number(match[2] ?? 0)
            }
          } else if (/^[12u] /.test(line)) {
            dirty = true
          }
        }
        if (branch.length === 0 || branch === '(detached)') {
          resolve(undefined)
          return
        }
        resolve({ branch, ahead, behind, dirty })
      },
    )
  })
}
