import { useApp } from '../store';
import { deliverExportedFile } from './desktop';
import { t as tr } from '../i18n';

/** 导出统一出口：桌面端弹系统「另存为」，网页端保持写入默认导出目录。 */
export async function deliverExport(file: { path: string; rows: number }, message = tr("导出")): Promise<void> {
  const { notify } = useApp.getState();
  const saved = await deliverExportedFile(file.path);
  if (!saved) {
    notify('success', message, tr("{0} 行 · {1}", [file.rows, file.path]));
    return;
  }
  if (saved.ok) {
    notify('success', message, tr("{0} 行 · {1}", [file.rows, saved.path ?? file.path]));
    return;
  }
  if (saved.canceled) {
    notify('info', message, tr("{0} 行 · 未选择位置，文件仍在 {1}", [file.rows, file.path]));
    return;
  }
  notify('error', tr("保存导出文件失败"), tr("{0}（文件在 {1}）", [saved.error ?? tr("未知错误"), file.path]));
}
