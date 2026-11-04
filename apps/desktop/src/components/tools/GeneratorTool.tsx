import { useEffect, useMemo, useState } from 'react';
import { Loader2, Sparkles, Wand2 } from 'lucide-react';
import { applyCapabilityDefaults, CAPABILITIES, getCapability, type Capability } from '@aidb/core';
import { api } from '../../lib/api';
import { useApp } from '../../store';
import { askConfirm } from '../AskDialog';
import { useDatabaseTables } from '../DatabaseSelect';
import { CapabilityForm } from './CapabilityForm';
import { t as tr } from '../../i18n';

/**
 * 数据生成 —— 表单向能力契约（`capabilities/generate.json`）迁移后的实现。
 *
 * 字段、默认值、必填与可见性全部来自契约；本组件只保留「选表 → 预览 / 插入」
 * 这条业务动线。渲染器见 `../CapabilityForm.tsx`。
 */
export function GeneratorTool() {
  const activeConnectionId = useApp((s) => s.activeConnectionId);
  const connections = useApp((s) => s.connections);
  const loadSchema = useApp((s) => s.loadSchema);
  const notify = useApp((s) => s.notify);
  const conn = connections.find((c) => c.id === activeConnectionId);

  const capability = useMemo<Capability>(() => getCapability('generate') ?? CAPABILITIES[0], []);
  const [values, setValues] = useState<Record<string, unknown>>(() => applyCapabilityDefaults(capability));
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);

  const table = String(values.table ?? '');
  const rows = Number(values.rows ?? 10);

  // 契约里有 table 字段但没有「默认选中第一张表」的语义——这是 UI 便利，必须在组件里补回。
  // 缺了它，用户打开面板时下拉显示「（未选择）」，按钮一直是禁用的。
  const tables = useDatabaseTables(activeConnectionId ?? undefined, String(values.database ?? ''));
  useEffect(() => {
    if (!tables.length) {
      setValues((current) => (current.table ? { ...current, table: '' } : current));
      return;
    }
    setValues((current) => {
      const currentTable = String(current.table ?? '');
      if (tables.some((item) => item.name === currentTable)) return current;
      return { ...current, table: tables[0].name };
    });
  }, [tables]);

  const onChange = (key: string, value: unknown) => {
    setValues((current) => {
      const next = { ...current, [key]: value };
      if (key === 'table') setResult(null);
      return next;
    });
  };

  const generate = async (dryRun: boolean) => {
    if (!activeConnectionId || !table) return;
    setLoading(true);
    try {
      const { result: generated } = await api.generateData({
        connectionId: activeConnectionId,
        database: values.database || undefined,
        table,
        rows,
        dryRun,
      });
      setResult(generated);
      if (!dryRun) {
        notify('success', tr("示例数据已生成"), tr("{0} 行 → {1}", [generated.inserted, table]));
        await loadSchema(activeConnectionId, true, (values.database as string) || undefined);
      }
    } catch (err: any) {
      notify('error', tr("生成失败"), err?.message);
    } finally {
      setLoading(false);
    }
  };

  if (!conn) return <div className="dash-empty">{tr("请选择连接。")}</div>;

  return (
    <div className="tool-pane">
      <div className="tool-pane-head">
        <Sparkles size={15} /> {tr(" 数据生成 ")}<span className="muted">{tr("按列名/类型生成贴近业务的测试数据，自动处理外键")}</span>
      </div>
      <div className="tool-row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <CapabilityForm
          capability={capability}
          values={values}
          onChange={onChange}
          connectionId={activeConnectionId ?? undefined}
          disabled={loading}
          testIdPrefix="generate"
        />
        <button className="btn" onClick={() => void generate(true)} disabled={loading || !table}>
          {loading ? <Loader2 size={12} className="spin" style={{ animation: 'spin .8s linear infinite' }} /> : <Wand2 size={12} />}{tr(" 预览 ")}</button>
        <button
          className="btn primary"
          onClick={async () => {
            if (!(await askConfirm({ message: tr("向 {0} 插入 {1} 行生成数据？", [table, rows]), detail: tr("数据会直接写入表，不经过预览。"), confirmLabel: tr("生成") }))) return;
            void generate(false);
          }}
          disabled={loading || !table}
        >
          <Sparkles size={12} /> {tr(" 生成并插入 ")}</button>
      </div>

      <div className="tool-scroll">
        {!result ? (
          <div className="dash-empty">
            {tr(" 生成器会跳过自增主键，按 name/email/status/amount/date 等语义与类型填充；外键会从被引用表中取现有值。 ")}</div>
        ) : (
          <>
            <div className="tool-summary">
              {result.table} · {result.columns.length}{tr(" 列 · ")}{result.dryRun ? tr("预览") : tr("已插入 {0} 行", [result.inserted])}
            </div>
            <div className="mini-table-wrap">
              <table className="tool-table">
                <thead><tr>{result.columns.map((column: string) => <th key={column}>{column}</th>)}</tr></thead>
                <tbody>
                  {result.rowsPreview.map((row: unknown[], index: number) => (
                    <tr key={index}>{row.map((value, valueIndex) => <td key={valueIndex}>{value === null ? 'NULL' : String(value).slice(0, 80)}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="tool-section-title" style={{ marginTop: 10 }}>{tr("INSERT 预览")}</div>
            <pre className="sql-block" style={{ maxHeight: 180, overflow: 'auto' }}>{result.sqlPreview}</pre>
          </>
        )}
      </div>
    </div>
  );
}
