import { spawn, type ChildProcess } from 'node:child_process';

/**
 * 终止子进程及其整个进程树（从 builtinMcp.ts 提取，供 skillRunner / mcp 复用）：
 * - POSIX：先 SIGTERM，500ms 后未退出再 SIGKILL（负 pid 连带杀进程组，
 *   要求 spawn 时 detached:true 让子进程自成进程组，否则退回直接信号）。
 * - Windows：taskkill /pid <pid> /T /F 直接强杀整棵进程树（/T 连带子进程）。
 *   shell:true 场景 child.pid 是 cmd.exe 的 pid，只有 /T 才能杀到真正的孙进程。
 * 避免子进程挂死时只杀直接子进程、却遗留孙进程的场景。
 */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {
        try {
          child.kill();
        } catch {
          /* 已退出 */
        }
      });
    } catch {
      /* taskkill 不存在时退回默认信号 */
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    /* 进程组不存在，退回直接信号 */
    try {
      child.kill('SIGTERM');
    } catch {
      /* 已退出 */
    }
  }
  const killer = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
  }, 500);
  killer.unref?.();
}