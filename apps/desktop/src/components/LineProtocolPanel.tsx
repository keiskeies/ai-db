import { useState } from 'react';
import { FilePlus } from 'lucide-react';
import type { ConnectionConfig } from '@aidb/core';
import { api } from '../lib/api';
import { useApp } from '../store';
import { Modal, Spinner } from './ui';
import { t as tr } from '../i18n';

const SAMPLE = 'cpu,host=a value=1.0 1700000000000000000\ncpu,host=b value=2.0 1700000060000000000';

/** InfluxDB v3 的 SQL 只读，写入只能走行协议。 */
export function LineProtocolPanel({
  connection,
  database,
  onClose,
  onDone,
}: {
  connection: ConnectionConfig;
  database?: string;
  onClose: () => void;
  onDone?: () => void;
}) {
  const notify = useApp((s) => s.notify);
  const [text, setText] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) {
      setError(tr("至少需要一行行协议"));
      return;
    }
    setRunning(true);
    setError(null);
    try {
      const { result } = await api.writeLineProtocol({ connectionId: connection.id, database, lines });
      notify('success', tr("已写入时序数据"), tr("{0} 行", [result.written]));
      onDone?.();
      onClose();
    } catch (err: any) {
      setError(err?.message ?? tr("写入失败"));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      title={tr("写入行协议")}
      icon={<FilePlus size={15} />}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={running}>{tr("取消")}</button>
          <button className="btn primary" onClick={() => void submit()} disabled={running} data-testid="line-protocol-submit">
            {running ? <Spinner /> : null}{tr(" 写入 ")}</button>
        </>
      }
    >
      <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
        {tr(" InfluxDB 的 SQL 接口只读；这里按行协议写入，格式 ")}<code>measurement,tag=v field=v timestamp</code>{tr("，时间戳用纳秒。 ")}</div>
      <textarea
        className="textarea grow"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={SAMPLE}
        spellCheck={false}
        style={{ minHeight: 200 }}
        data-testid="line-protocol-input"
      />
      {error ? <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 10 }} data-testid="line-protocol-error">{error}</div> : null}
    </Modal>
  );
}