import { useMemo } from 'react';
import { applyCapabilityDefaults, type Capability, type CapabilityField } from '@aidb/core';
import { useApp } from '../../store';
import { DatabaseSelect, useDatabaseTables } from '../DatabaseSelect';
import { Select, Option } from '../ui';
import { t as tr } from '../../i18n';

/**
 * 由能力契约驱动的表单渲染器。
 *
 * 契约（`packages/core/src/capabilities/<id>.json`）是字段知识的唯一来源；
 * 这里只负责把 `CapabilityField` 映射到已有控件，不承载任何业务校验——
 * 校验在 service 端由 `validateCapabilityInput()` 完成。
 *
 * ## 渲染契约（改这里之前先读）
 *
 * 契约与渲染之间有几条**不在类型系统里**的约定，违反会静默出错：
 *
 * 1. **默认值由调用方负责。** 本组件不会把 `field.default` 写回 `values`；
 *    调用方初始化状态时应使用 `applyCapabilityDefaults(capability)`。
 *    如果忘了，`showWhen` 依赖默认值的字段会判成隐藏（例：`jobs.sql` 依赖
 *    `type` 默认等于 `'query'`，不补默认值时 SQL 输入框不显示，但提交报「必填」）。
 *
 * 2. **`showWhen` 只看 `values`。** 本组件不替调用方补默认值再判断可见性——
 *    它假设调用方已经补过（见第 1 条）。
 *
 * 3. **`connection` 字段在传入 `connectionId` 时不渲染。** 调用方若把连接固定为
 *    当前连接，就不该再让用户改；此时 `values` 里可以没有该字段，但下游
 *    `database` / `table` 字段会回退到 `connectionId` prop。
 *
 * 4. **`database` 控件可能是空盒子。** `DatabaseSelect` 在「库数 ≤ 1」时返回 null。
 *    本组件会保留挂载（自动选中默认库的副作用在它内部）、只隐藏外壳；
 *    **卸载它会让 `table` 选择器永远为空**。
 *
 * 5. **`table` / `tables` 依赖同表单的 `database` 取值**，见 `TableField`。
 *
 * 6. **`omit` 用于「调用方自建控件」。** 该字段仍参与 `values`，只是不渲染；
 *    调用方要保证自建控件与契约的语义一致（例：搜索面板的 search-box 就是
 *    `query` 字段的自建控件）。
 *
 * 7. **本组件不改 `values` 的形状**，只通过 `onChange(key, value)` 通知。
 */
export interface CapabilityFormProps {
  capability: Capability;
  /** 当前取值；由调用方持有。初始化请用 `applyCapabilityDefaults()`。 */
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  /** 连接 id 固定绑到当前连接时传它，表单里就不再渲染 connection 字段。 */
  connectionId?: string;
  /** 是否渲染 `advanced` 字段。 */
  showAdvanced?: boolean;
  /** 禁用全部控件。 */
  disabled?: boolean;
  testIdPrefix?: string;
  /**
   * 不渲染的字段。用于「这个字段的控件由调用方自己提供」的场景，
   * 例如数据库搜索的关键词输入框是定制的 search-box，不是普通 input。
   * 取值仍由 `values` 携带，只是不在这里出控件。
   */
  omit?: string[];
}

function visible(field: CapabilityField, values: Record<string, unknown>): boolean {
  if (!field.showWhen) return true;
  return values[field.showWhen.field] === field.showWhen.equals;
}

/** 表格选择器：依赖同表单的 connection + database。 */
function TableField({
  field,
  values,
  onChange,
  connectionId,
  disabled,
  testId,
}: {
  field: CapabilityField;
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  connectionId: string;
  disabled: boolean;
  testId: string;
}) {
  // 表选择器依赖「同表单的 database 字段」。
  // 命名约定：`table` / `tables` → `database`；带前缀的 `sourceTable` → `sourceDatabase`。
  // 小写首字母，避免推导出 `Database` / `SourceDatabase` 这种不存在的 key。
  const derived = field.key.replace(/(tables?)$/i, 'Database');
  const databaseKey = derived === 'Database' ? 'database' : `${derived[0].toLowerCase()}${derived.slice(1)}`;
  const database = String(values.database ?? values[databaseKey] ?? '');
  const tables = useDatabaseTables(connectionId, database);
  if (field.type === 'tables') {
    const selected = new Set(Array.isArray(values[field.key]) ? (values[field.key] as string[]) : []);
    return (
      <div className="row gap-6" style={{ flexWrap: 'wrap' }} data-testid={testId}>
        {tables.length ? (
          tables.map((table) => (
            <label key={table.name} className="transfer-row" style={{ fontSize: 11, width: "auto" }}>
              <input
                type="checkbox"
                checked={selected.has(table.name)}
                disabled={disabled}
                onChange={(event) => {
                  const next = new Set(selected);
                  if (event.target.checked) next.add(table.name);
                  else next.delete(table.name);
                  onChange(field.key, [...next]);
                }}
              />
              {table.name}
            </label>
          ))
        ) : (
          <span className="muted" style={{ fontSize: 11 }}>{tr("先选择数据库")}</span>
        )}
      </div>
    );
  }
  return (
    <Select
      className="select"
      value={String(values[field.key] ?? '')}
      disabled={disabled || !tables.length}
      onChange={(event) => onChange(field.key, event.target.value)}
      data-testid={testId}
    >
      <Option value="">{tr("（未选择）")}</Option>
      {tables.map((table) => (
        <Option key={table.name} value={table.name}>
          {table.name} · {table.columns?.length ?? 0}{tr(" 列 ")}</Option>
      ))}
    </Select>
  );
}

export function CapabilityForm({
  capability,
  values,
  onChange,
  connectionId,
  showAdvanced = false,
  disabled = false,
  testIdPrefix = 'cap',
  omit,
}: CapabilityFormProps) {
  // DatabaseSelect 在「只有一个库」时直接返回 null；如果这里不提前跳过，
  // 会留下一个只有 label、没有控件的空字段。默认库仍由 DatabaseSelect 内部自动选中。
  const schemas = useApp((state) => {
    const id = String(values.connectionId ?? connectionId ?? '');
    return id ? state.schemas[id] : undefined;
  });
  const databaseCount = schemas?.length ?? 0;

  const fields = useMemo(
    () =>
      capability.fields.filter((field) => {
        if (!visible(field, values)) return false;
        if (field.advanced && !showAdvanced) return false;
        // 连接固定绑定时不渲染连接字段，避免用户误改到别的库
        if (field.type === 'connection' && connectionId) return false;
        // 调用方自建了该字段的控件（如搜索面板的 search-box）
        if (omit?.includes(field.key)) return false;
        return true;
      }),
    [capability.fields, values, showAdvanced, connectionId, omit],
  );

  return (
    <div className="capability-form" data-testid={`${testIdPrefix}-form`} data-capability={capability.id}>
      {fields.map((field) => {
        const testId = `${testIdPrefix}-${field.key}`;
        const label = `${tr(field.label.zh)}${field.required ? ' *' : ''}`;
        const common = { disabled, 'data-testid': testId };

        if (field.type === 'connection' || field.type === 'database') {
          // DatabaseSelect 在 options.length <= 1 时返回 null（不管 allowAll）。
          // 这时仍要挂载它——自动选中默认库的副作用发生在组件内部，卸载会让
          // 依赖它的表选择器永远为空。因此保留挂载，只把空外壳隐藏掉。
          const collapse = field.type === 'database' && databaseCount <= 1;
          return (
            <div className="field" key={field.key} style={collapse ? { display: 'none' } : undefined}>
              <label>{label}</label>
              {field.type === 'connection' ? (
                <ConnectionField field={field} values={values} onChange={onChange} disabled={disabled} testId={testId} />
              ) : (
                <DatabaseSelect
                  // 不要从 required 推导 allowAll：required 只表示「必须有值」。
                  // 传 allowAll 会让 DatabaseSelect 跳过自动选中连接默认库，导致
                  // 依赖 database 的表选择器永远为空。只有契约显式声明才加「全部库」。
                  allowAll={field.allowAll === true}
                  connectionId={String(values.connectionId ?? connectionId ?? '')}
                  value={String(values[field.key] ?? '')}
                  onChange={(value) => onChange(field.key, value)}
                  testId={testId}
                />
              )}
            </div>
          );
        }

        if (field.type === 'table' || field.type === 'tables') {
          return (
            <div className="field" key={field.key} style={{ flex: 1, minWidth: 200 }}>
              <label>{label}</label>
              <TableField
                field={field}
                values={values}
                onChange={onChange}
                connectionId={String(values.connectionId ?? connectionId ?? '')}
                disabled={disabled}
                testId={testId}
              />
            </div>
          );
        }

        if (field.type === 'enum') {
          return (
            <div className="field" key={field.key}>
              <label>{label}</label>
              <Select
                className="select"
                value={String(values[field.key] ?? field.default ?? '')}
                onChange={(event) => onChange(field.key, event.target.value)}
                {...common}
              >
                {(field.options ?? []).map((option) => (
                  <Option key={option.value} value={option.value}>
                    {tr(option.label.zh)}
                    {option.risk && option.risk !== 'read' ? `（${option.risk}）` : ''}
                  </Option>
                ))}
              </Select>
              {field.hint ? <span className="muted" style={{ fontSize: 10 }}>{tr(field.hint)}</span> : null}
            </div>
          );
        }

        if (field.type === 'boolean') {
          return (
            <label key={field.key} className="transfer-row" style={{ alignSelf: 'flex-end', width: 'auto' }}>
              <input
                type="checkbox"
                checked={values[field.key] === undefined ? Boolean(field.default) : Boolean(values[field.key])}
                onChange={(event) => onChange(field.key, event.target.checked)}
                {...common}
              />
              {tr(field.label.zh)}
            </label>
          );
        }

        if (field.type === 'number') {
          return (
            <div className="field" key={field.key} style={{ width: 140 }}>
              <label>{label}</label>
              <input
                className="input"
                type="number"
                min={field.min}
                max={field.max}
                value={Number(values[field.key] ?? field.default ?? 0)}
                onChange={(event) => onChange(field.key, Number(event.target.value))}
                {...common}
              />
              {field.hint ? <span className="muted" style={{ fontSize: 10 }}>{tr(field.hint)}</span> : null}
            </div>
          );
        }

        if (field.type === 'code') {
          return (
            <div className="field" key={field.key} style={{ flexBasis: '100%' }}>
              <label>
                {label}
                {field.language ? <span className="muted" style={{ fontSize: 10 }}> · {field.language}</span> : null}
              </label>
              <textarea
                className="textarea"
                rows={4}
                value={String(values[field.key] ?? '')}
                onChange={(event) => onChange(field.key, event.target.value)}
                placeholder={field.signature ? tr("入参 {0} → 出参 {1}", [field.signature.input ?? '-', field.signature.output ?? '-']) : undefined}
                {...common}
              />
              {field.hint ? <span className="muted" style={{ fontSize: 10 }}>{tr(field.hint)}</span> : null}
            </div>
          );
        }

        return (
          <div className="field" key={field.key} style={{ flex: 1, minWidth: 160 }}>
            <label>{label}</label>
            <input
              className="input"
              value={String(values[field.key] ?? '')}
              onChange={(event) => onChange(field.key, event.target.value)}
              {...common}
            />
            {field.hint ? <span className="muted" style={{ fontSize: 10 }}>{tr(field.hint)}</span> : null}
          </div>
        );
      })}
    </div>
  );
}

function ConnectionField({
  field,
  values,
  onChange,
  disabled,
  testId,
}: {
  field: CapabilityField;
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  disabled: boolean;
  testId: string;
}) {
  const connections = useApp((state) => state.connections);
  return (
    <Select
      className="select"
      value={String(values[field.key] ?? '')}
      disabled={disabled}
      onChange={(event) => onChange(field.key, event.target.value)}
      data-testid={testId}
    >
      <Option value="">{tr("（未选择）")}</Option>
      {connections.map((connection) => (
        <Option key={connection.id} value={connection.id}>
          {connection.name}
          {connection.readonly ? tr("（只读）") : ''}
        </Option>
      ))}
    </Select>
  );
}
