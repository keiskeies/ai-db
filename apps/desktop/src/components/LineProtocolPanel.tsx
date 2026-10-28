import { useState } from 'react';
import { FilePlus } from 'lucide-react';
import type { ConnectionConfig } from '@aidb/core';
import { api } from '../lib/api';
import { useApp } from '../store';
import { Modal, Spinner } from './ui';

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
      setError('至少需要一行行协议');
      return;
    }
    setRunning(true);
    setError(null);
    try {
      const { result } = await api.writeLineProtocol({ connectionId: connection.id, database, lines });
      notify('success', '已写入时序数据', `${result.written} 行`);
      onDone?.();
      onClose();
    } catch (err: any) {
      setError(err?.message ?? '写入失败');
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      title="写入行协议"
      icon={<FilePlus size={15} />}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={running}>取消</button>
          <button className="btn primary" onClick={() => void submit()} disabled={running} data-testid="line-protocol-submit">
            {running ? <Spinner /> : null} 写入
          </button>
        </>
      }
    >
      <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
        InfluxDB 的 SQL 接口只读；这里按行协议写入，格式 <code>measurement,tag=v field=v 时间戳</code>，时间戳用纳秒。
      </div>
      <textarea
        className="textarea"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={SAMPLE}
        spellCheck={false}
        style={{ width: '100%', minHeight: 200, fontFamily: 'var(--font-mono)', fontSize: 12 }}
        data-testid="line-protocol-input"
      />
      {error ? <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 10 }} data-testid="line-protocol-error">{error}</div> : null}
    </Modal>
  );
}