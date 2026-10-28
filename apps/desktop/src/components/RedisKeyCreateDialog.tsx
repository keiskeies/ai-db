import { useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../store';
import { Modal, Spinner } from './ui';

const TYPES = ['string', 'hash', 'list', 'set', 'zset'] as const;
type KeyType = (typeof TYPES)[number];

const PLACEHOLDER: Record<KeyType, string> = {
  string: '键值（原样存储的文本）',
  hash: '{"name":"Ada","age":"36"}',
  list: '["first","second"]',
  set: '["a","b","c"]',
  zset: '{"alice":1,"bob":2}',
};

const HINT: Record<KeyType, string> = {
  string: '直接输入文本，保存为 SET。',
  hash: '输入 JSON 对象（字段 → 值），保存为 HSET。',
  list: '输入 JSON 数组，按顺序 RPUSH。',
  set: '输入 JSON 数组，SADD 去重。',
  zset: '输入 JSON 对象（成员 → 分数），保存为 ZADD。',
};

export function RedisKeyCreateDialog({
  connectionId,
  database,
  onClose,
  onCreated,
}: {
  connectionId: string;
  database?: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const notify = useApp((s) => s.notify);
  const [key, setKey] = useState('');
  const [type, setType] = useState<KeyType>('string');
  const [valueText, setValueText] = useState('');
  const [ttl, setTtl] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!key.trim()) {
      setError('键名不能为空');
      return;
    }
    let value: unknown;
    if (type === 'string') {
      if (!valueText.length) {
        setError('string 键需要一个值');
        return;
      }
      value = valueText;
    } else {
      try {
        value = JSON.parse(valueText);
      } catch {
        setError('取值需要是合法 JSON');
        return;
      }
      const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);
      if ((type === 'hash' || type === 'zset') && !isObject) {
        setError(`${type} 键需要一个 JSON 对象`);
        return;
      }
      if ((type === 'list' || type === 'set') && !Array.isArray(value)) {
        setError(`${type} 键需要一个 JSON 数组`);
        return;
      }
    }
    const ttlSeconds = ttl.trim() === '' ? null : Number(ttl);
    if (ttlSeconds !== null && (!Number.isFinite(ttlSeconds) || ttlSeconds < 1)) {
      setError('TTL 需要是正整数秒');
      return;
    }
    setRunning(true);
    try {
      const { result } = await api.createRedisKey({ connectionId, database, key: key.trim(), type, value, ttl: ttlSeconds });
      notify('success', '键已创建', result.key);
      onCreated();
      onClose();
    } catch (err: any) {
      setError(err?.message ?? '创建失败');
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      title="新建键"
      icon={<Plus size={15} />}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={running}>取消</button>
          <button className="btn primary" onClick={() => void submit()} disabled={running} data-testid="key-create-submit">
            {running ? <Spinner /> : null} 创建
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label>键名</label>
        <input
          className="input"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          placeholder="user:1"
          autoFocus
          data-testid="key-create-name"
        />
        <label>类型</label>
        <select className="select" value={type} onChange={(event) => setType(event.target.value as KeyType)} data-testid="key-create-type">
          {TYPES.map((item) => (
            <option key={item} value={item}>{item}</option>
          ))}
        </select>
        <label>TTL（秒）</label>
        <input
          className="input"
          value={ttl}
          onChange={(event) => setTtl(event.target.value.replace(/\D/g, ''))}
          placeholder="留空表示永不过期"
          inputMode="numeric"
          data-testid="key-create-ttl"
        />
      </div>
      <div className="muted" style={{ fontSize: 11, margin: '12px 0 6px' }}>{HINT[type]}</div>
      <textarea
        className="textarea"
        value={valueText}
        onChange={(event) => setValueText(event.target.value)}
        placeholder={PLACEHOLDER[type]}
        spellCheck={false}
        style={{ width: '100%', minHeight: 140, fontFamily: 'var(--font-mono)', fontSize: 12 }}
        data-testid="key-create-value"
      />
      {error ? <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 10 }} data-testid="key-create-error">{error}</div> : null}
    </Modal>
  );
}