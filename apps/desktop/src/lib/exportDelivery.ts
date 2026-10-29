import { useApp } from '../store';
import { deliverExportedFile } from './desktop';

/** 导出统一出口：桌面端弹系统「另存为」，网页端保持写入默认导出目录。 */
export async function deliverExport(file: { path: string; rows: number }, message = '导出'): Promise<void> {
  const { notify } = useApp.getState();
  const saved = await deliverExportedFile(file.path);
  if (!saved) {
    notify('success', message, `${file.rows} 行 · ${file.path}`);
    return;
  }
  if (saved.ok) {
    notify('success', message, `${file.rows} 行 · ${saved.path ?? file.path}`);
    return;
  }
  if (saved.canceled) {
    notify('info', message, `${file.rows} 行 · 未选择位置，文件仍在 ${file.path}`);
    return;
  }
  notify('error', '保存导出文件失败', `${saved.error ?? '未知错误'}（文件在 ${file.path}）`);
}
