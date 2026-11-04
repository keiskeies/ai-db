import { useEffect, useState } from 'react';
import type { RedisKeyDetail } from '@aidb/core';
import { api } from '../lib/api';
import { useApp } from '../store';
import { DataGrid } from './DataGrid';
import { Modal, Spinner } from './ui';
import { t as tr } from '../i18n';

function ttlText(ttl: number): string {
  if (ttl === -2) return tr("键已过期");
  if (ttl === -1) return tr("永不过期");
  return tr("剩余 {0}s", [ttl]);
}

export function RedisKeyDialog({
  connectionId,
  database,
  keyName,
  onClose,
}: {
  connectionId: string;
  database?: string;
  keyName: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<RedisKeyDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [ttlInput, setTtlInput] = useState('');
  const [renameTo, setRenameTo] = useState('');
  const [valueText, setValueText] = useState('');
  const [memberInput, setMemberInput] = useState('');
  const [memberScore, setMemberScore] = useState('');
  const [listItem, setListItem] = useState<{ index: number; value: string } | null>(null);
  const [editField, setEditField] = useState<{ field: string; value: string } | null>(null);
  const [mutating, setMutating] = useState(false);
  const connections = useApp((s) => s.connections);
  const notify = useApp((s) => s.notify);
  const loadSchema = useApp((s) => s.loadSchema);
  const conn = connections.find((item) => item.id === connectionId);

  const applyTtl = async (seconds: number | null) => {
    setMutating(true);
    setError(null);
    try {
      await api.setKeyTtl({ connectionId, database, key: keyName, seconds });
      const { detail: found } = await api.redisKey({ connectionId, database, key: keyName });
      setDetail(found);
      notify('success', seconds === null ? tr("已移除过期时间") : tr("已设置过期时间"), keyName);
    } catch (err: any) {
      setError(err?.message ?? tr("设置 TTL 失败"));
    } finally {
      setMutating(false);
    }
  };

  const saveValue = async () => {
    setMutating(true);
    setError(null);
    try {
      await api.setRedisKeyValue({ connectionId, database, key: keyName, value: valueText });
      const { detail: found } = await api.redisKey({ connectionId, database, key: keyName });
      setDetail(found);
      notify('success', tr("键值已保存"), keyName);
    } catch (err: any) {
      setError(err?.message ?? tr("保存键值失败"));
    } finally {
      setMutating(false);
    }
  };

  const saveListItem = async () => {
    if (!listItem) return;
    setMutating(true);
    setError(null);
    try {
      await api.setListItem({ connectionId, database, key: keyName, index: listItem.index, value: listItem.value });
      notify('success', tr("列表元素已改写"), `#${listItem.index}`);
      setListItem(null);
      await load();
    } catch (err: any) {
      setError(err?.message ?? tr("改写失败"));
    } finally {
      setMutating(false);
    }
  };

  const addMember = async () => {
    const member = memberInput.trim();
    if (!member) {
      setError(tr("成员不能为空"));
      return;
    }
    setMutating(true);
    setError(null);
    try {
      const score = detail?.type === 'zset' ? Number(memberScore) : undefined;
      if (detail?.type === 'zset' && !Number.isFinite(score)) {
        setError(tr("zset 成员需要数字分数"));
        setMutating(false);
        return;
      }
      await api.addKeyMember({ connectionId, database, key: keyName, member, score });
      setMemberInput('');
      setMemberScore('');
      await load();
      notify('success', tr("成员已写入"), member);
    } catch (err: any) {
      setError(err?.message ?? tr("写入成员失败"));
    } finally {
      setMutating(false);
    }
  };

  const removeMember = async (member: string) => {
    setMutating(true);
    setError(null);
    try {
      const { result } = await api.removeKeyMember({ connectionId, database, key: keyName, member });
      notify('success', result.deleted ? tr("成员已删除") : tr("成员已不存在"), result.keyGone ? tr("{0}（键已空，整键删除）", [member]) : member);
      if (result.keyGone) {
        void loadSchema(connectionId, true, database).catch(() => undefined);
        onClose();
        return;
      }
      await load();
    } catch (err: any) {
      setError(err?.message ?? tr("删除成员失败"));
    } finally {
      setMutating(false);
    }
  };

  const saveHashField = async () => {
    if (!editField) return;
    const field = editField.field.trim();
    if (!field) {
      setError(tr("字段名不能为空"));
      return;
    }
    setMutating(true);
    setError(null);
    try {
      await api.setHashField({ connectionId, database, key: keyName, field, value: editField.value });
      notify('success', tr("字段已保存"), field);
      setEditField(null);
      await load();
    } catch (err: any) {
      setError(err?.message ?? tr("保存字段失败"));
    } finally {
      setMutating(false);
    }
  };

  const removeHashField = async (field: string) => {
    setMutating(true);
    setError(null);
    try {
      const { result } = await api.deleteHashField({ connectionId, database, key: keyName, field });
      notify('success', result.deleted ? tr("字段已删除") : tr("字段已不存在"), result.keyGone ? tr("{0}（键已空，整键删除）", [field]) : field);
      if (result.keyGone) {
        void loadSchema(connectionId, true, database).catch(() => undefined);
        onClose();
        return;
      }
      await load();
    } catch (err: any) {
      setError(err?.message ?? tr("删除字段失败"));
    } finally {
      setMutating(false);
    }
  };

  const doRename = async () => {
    const target = renameTo.trim();
    if (!target) {
      setError(tr("需要输入新的键名"));
      return;
    }
    setMutating(true);
    setError(null);
    try {
      await api.renameKey({ connectionId, database, key: keyName, to: target });
      notify('success', tr("键已重命名"), `${keyName} → ${target}`);
      void loadSchema(connectionId, true, database).catch(() => undefined);
      onClose();
    } catch (err: any) {
      setError(err?.message ?? tr("重命名失败"));
      setMutating(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    setError(null);
    try {
      const { result } = await api.deleteRedisKeys({ connectionId, database, keys: [keyName] });
      notify('success', result.deleted ? tr("键已删除") : tr("键已不存在"), keyName);
      onClose();
    } catch (err: any) {
      setError(err?.message ?? tr("删除失败"));
      setConfirming(false);
    } finally {
      setDeleting(false);
    }
  };

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const { detail: found } = await api.redisKey({ connectionId, database, key: keyName });
      setDetail(found);
      if (found.type === 'string') setValueText(String(found.rows[0]?.[0] ?? ''));
    } catch (err: any) {
      setError(err?.message ?? tr("读取键失败"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, database, keyName]);

  return (
    <Modal
      title={keyName}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={() => void load()} disabled={loading || deleting} data-testid="redis-key-refresh">
            {tr(" 刷新 ")}</button>
          {conn && !conn.readonly ? (
            confirming ? (
              <>
                <input
                  className="input"
                  style={{ width: 170 }}
                  value={typed}
                  placeholder={tr("输入 {0} 确认", [keyName])}
                  onChange={(event) => setTyped(event.target.value)}
                  data-testid="redis-key-confirm"
                />
                <button
                  className="btn danger"
                  onClick={() => void remove()}
                  disabled={deleting || typed.trim() !== keyName}
                  data-testid="redis-key-delete-submit"
                >
                  {deleting ? <Spinner /> : null}{tr(" 确认删除 ")}</button>
                <button className="btn" onClick={() => { setConfirming(false); setTyped(''); }} disabled={deleting}>
                  {tr(" 取消 ")}</button>
              </>
            ) : (
              <button className="btn danger" onClick={() => setConfirming(true)} disabled={deleting} data-testid="redis-key-delete">
                {tr(" 删除键 ")}</button>
            )
          ) : null}
          <button className="btn primary" onClick={onClose} disabled={deleting}>{tr("关闭")}</button>
        </>
      }
    >
      {loading && !detail ? <Spinner /> : null}
      {error ? <div style={{ color: 'var(--danger)', fontSize: 12 }} data-testid="redis-key-error">{error}</div> : null}
      {detail ? (
        <>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11, color: 'var(--text-secondary)', marginBottom: 10 }}>
            <span data-testid="redis-key-type">{tr("类型 ")}{detail.type}</span>
            <span data-testid="redis-key-ttl">TTL {ttlText(detail.ttl)}</span>
            {detail.size !== null && detail.size !== undefined ? <span>{tr("规模 ")}{detail.size}</span> : null}
            {detail.encoding ? <span>{tr("编码 ")}{detail.encoding}</span> : null}
          </div>
          {conn && !conn.readonly ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }} data-testid="redis-key-actions">
              <input
                className="input"
                style={{ width: 110 }}
                value={ttlInput}
                placeholder={tr("秒数")}
                onChange={(event) => setTtlInput(event.target.value.replace(/\D/g, ''))}
                data-testid="key-ttl-input"
              />
              <button
                className="btn small"
                onClick={() => void applyTtl(Number(ttlInput))}
                disabled={mutating || deleting || !ttlInput}
                data-testid="key-ttl-set"
              >
                {tr(" 设置 TTL ")}</button>
              <button className="btn small" onClick={() => void applyTtl(null)} disabled={mutating || deleting} data-testid="key-ttl-clear">
                {tr(" 移除过期 ")}</button>
              <input
                className="input"
                style={{ width: 200 }}
                value={renameTo}
                placeholder={tr("新键名（原：{0}）", [keyName])}
                onChange={(event) => setRenameTo(event.target.value)}
                data-testid="key-rename-input"
              />
              <button
                className="btn small"
                onClick={() => void doRename()}
                disabled={mutating || deleting || !renameTo.trim()}
                data-testid="key-rename-submit"
              >
                {tr(" 重命名… ")}</button>
            </div>
          ) : null}
          {detail.note ? <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>{detail.note}</div> : null}
          {detail.type === 'string' && conn && !conn.readonly ? (
            <div>
              <textarea
                className="textarea grow"
                value={valueText}
                onChange={(event) => setValueText(event.target.value)}
                spellCheck={false}
                style={{ minHeight: 120 }}
                data-testid="key-value-input"
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                <button
                  className="btn small primary"
                  onClick={() => void saveValue()}
                  disabled={mutating || deleting}
                  data-testid="key-value-save"
                >
                  {mutating ? <Spinner /> : null}{tr(" 保存值 ")}</button>
                <span className="muted" style={{ fontSize: 11 }}>{tr("SET KEEPTTL，保留原过期时间")}</span>
              </div>
            </div>
          ) : detail.type === 'hash' && conn && !conn.readonly ? (
            <>
              <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
                {tr(" 双击字段行修改取值；字段行右侧可删除该字段。新增字段会直接写入。 ")}</div>
              <DataGrid
                columns={detail.columns}
                rows={detail.rows}
                testId="redis-key-grid"
                onRowActivate={(rowIndex) => {
                  const row = detail.rows[rowIndex] ?? [];
                  setEditField({ field: String(row[0] ?? ''), value: String(row[1] ?? '') });
                }}
              />
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                {detail.rows.map((row, index) => (
                  <button
                    key={`${String(row[0])}-${index}`}
                    className="btn small"
                    disabled={mutating || deleting}
                    onClick={() => void removeHashField(String(row[0] ?? ''))}
                    title={tr("删除字段 {0}", [String(row[0])])}
                    data-testid={`hash-field-delete-${String(row[0])}`}
                  >
                    × {String(row[0])}
                  </button>
                ))}
              </div>
              {editField ? (
                <div style={{ marginTop: 10 }} data-testid="hash-field-editor">
                  <div className="form-grid">
                    <label>{tr("字段")}</label>
                    <input
                      className="input"
                      value={editField.field}
                      onChange={(event) => setEditField({ ...editField, field: event.target.value })}
                      data-testid="hash-field-name"
                    />
                  </div>
                  <textarea
                    className="textarea grow"
                    value={editField.value}
                    onChange={(event) => setEditField({ ...editField, value: event.target.value })}
                    spellCheck={false}
                    style={{ minHeight: 90, marginTop: 8 }}
                    data-testid="hash-field-value"
                  />
                  <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                    <button
                      className="btn small primary"
                      onClick={() => void saveHashField()}
                      disabled={mutating}
                      data-testid="hash-field-save"
                    >
                      {mutating ? <Spinner /> : null}{tr(" 保存字段 ")}</button>
                    <button className="btn small" onClick={() => setEditField(null)} disabled={mutating}>
                      {tr(" 取消 ")}</button>
                  </div>
                </div>
              ) : null}
            </>
          ) : (detail.type === 'list' || detail.type === 'set' || detail.type === 'zset') && conn && !conn.readonly ? (
            <>
              <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
                {detail.type === 'list' ? tr("双击行按索引改写；新成员追加到列表尾部") : tr("按成员名增删")}{tr("；下方可逐个删除，删空后整键会消失。 ")}</div>
              <DataGrid
                columns={detail.columns}
                rows={detail.rows}
                testId="redis-key-grid"
                onRowActivate={
                  detail.type === 'list'
                    ? (rowIndex) => {
                        const row = detail.rows[rowIndex] ?? [];
                        setListItem({ index: Number(row[0] ?? 0), value: String(row[1] ?? '') });
                      }
                    : undefined
                }
              />
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                {detail.rows.map((row, index) => {
                  const member = String((detail.type === 'list' ? row[1] : row[0]) ?? '');
                  return (
                    <button
                      key={`${member}-${index}`}
                      className="btn small"
                      disabled={mutating || deleting}
                      onClick={() => void removeMember(member)}
                      title={tr("删除成员 {0}", [member])}
                      data-testid={`member-delete-${member}`}
                    >
                      × {member}
                    </button>
                  );
                })}
              </div>
              {detail.type === 'list' && listItem ? (
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }} data-testid="list-item-editor">
                  <span className="muted" style={{ fontSize: 11 }}>#{listItem.index}</span>
                  <input
                    className="input"
                    style={{ flex: 1, minWidth: 200 }}
                    value={listItem.value}
                    onChange={(event) => setListItem({ ...listItem, value: event.target.value })}
                    data-testid="list-item-value"
                  />
                  <button className="btn small primary" onClick={() => void saveListItem()} disabled={mutating} data-testid="list-item-save">
                    {mutating ? <Spinner /> : null}{tr(" 保存 ")}</button>
                  <button className="btn small" onClick={() => setListItem(null)} disabled={mutating}>
                    {tr(" 取消 ")}</button>
                </div>
              ) : null}
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }} data-testid="member-add-form">
                <input
                  className="input"
                  style={{ width: 200 }}
                  value={memberInput}
                  placeholder={tr("新成员")}
                  onChange={(event) => setMemberInput(event.target.value)}
                  data-testid="member-input"
                />
                {detail.type === 'zset' ? (
                  <input
                    className="input"
                    style={{ width: 100 }}
                    value={memberScore}
                    placeholder={tr("分数")}
                    onChange={(event) => setMemberScore(event.target.value)}
                    data-testid="member-score"
                  />
                ) : null}
                <button className="btn small primary" onClick={() => void addMember()} disabled={mutating || !memberInput.trim()} data-testid="member-add">
                  {mutating ? <Spinner /> : null}{tr(" 添加成员 ")}</button>
              </div>
            </>
          ) : detail.rows.length ? (
            <DataGrid columns={detail.columns} rows={detail.rows} testId="redis-key-grid" />
          ) : (
            <div className="muted" style={{ fontSize: 11 }}>{tr("没有可展示的取值")}</div>
          )}
        </>
      ) : null}
    </Modal>
  );
}
