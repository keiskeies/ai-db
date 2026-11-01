import { useMemo, useState } from 'react';
import { Boxes, ChevronDown, ChevronRight, Search } from 'lucide-react';
import { CAPABILITIES, type CapabilityField } from '@aidb/core';

/**
 * 设置 → 功能能力：只读的能力契约目录。
 *
 * 与「设置 → MCP 与工具 → Agent 工具目录」的区别：
 * - 那个列的是**工具**（模型能调用的动作，52 个）；
 * - 这里列的是**功能**（软件自带的界面能力，12 个工具箱模块）。
 *
 * 一个功能可能有零个或多个工具；没有工具时 Agent 只能引导用户去工具箱操作。
 * 契约文件在 `packages/core/src/capabilities/<id>.json`，同时驱动 Agent 能力
 * 提示词、REST 参数校验与部分 UI 表单。
 */
export function CapabilitiesTool() {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showAllFields, setShowAllFields] = useState(false);

  const matched = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return CAPABILITIES;
    return CAPABILITIES.filter(
      (capability) =>
        capability.id.toLowerCase().includes(needle) ||
        capability.title.zh.includes(query.trim()) ||
        capability.title.en.toLowerCase().includes(needle) ||
        capability.description.toLowerCase().includes(needle) ||
        capability.fields.some((field) => field.key.toLowerCase().includes(needle)) ||
        capability.tools.some((tool) => tool.toLowerCase().includes(needle)),
    );
  }, [query]);

  const toggle = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const totalFields = CAPABILITIES.reduce((sum, capability) => sum + capability.fields.length, 0);
  const withTools = CAPABILITIES.filter((capability) => capability.tools.length > 0).length;

  return (
    <div className="tool-pane capability-catalog-pane" data-testid="capability-catalog">
      <div className="tool-pane-head">
        <Boxes size={15} /> 功能能力
        <span className="muted">工具箱各模块的表单契约 · 只读</span>
      </div>

      <div className="tool-row" style={{ flexWrap: 'wrap' }}>
        <div className="search-box" style={{ flex: 1, minWidth: 220 }}>
          <Search size={12} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="按 id、标题、说明、字段名或工具名过滤，例如 transfer / 定时"
            aria-label="过滤功能能力"
          />
        </div>
        <label className="transfer-row" style={{ width: 'auto', fontSize: 11 }}>
          <input type="checkbox" checked={showAllFields} onChange={(e) => setShowAllFields(e.target.checked)} />
          展开全部字段
        </label>
        <span className="spacer" />
        <span className="badge">{matched.length} / {CAPABILITIES.length} 个功能</span>
        <span className="badge">{totalFields} 个字段</span>
        <span className="badge">{withTools} 个有工具</span>
      </div>

      <div className="tool-scroll capability-list">
        {!matched.length ? <div className="dash-empty">没有匹配的功能。</div> : null}
        {matched.map((capability) => {
          const isOpen = showAllFields || expanded.has(capability.id);
          return (
            <div key={capability.id} className="capability-card" data-capability={capability.id}>
              <button
                className="capability-card-head"
                onClick={() => toggle(capability.id)}
                aria-expanded={isOpen}
                data-testid={`capability-toggle-${capability.id}`}
              >
                {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <span className="mono capability-id">{capability.id}</span>
                <strong>{capability.title.zh}</strong>
                <span className={`badge ${capability.maxRisk}`.trim()}>{capability.maxRisk}</span>
                {capability.progress?.supported ? <span className="badge read">进度</span> : null}
                <span className="spacer" />
                <span className="muted" style={{ fontSize: 10 }}>
                  {capability.fields.length} 字段
                  {capability.tools.length ? ` · ${capability.tools.length} 工具` : ' · 无工具'}
                </span>
              </button>

              <div className="capability-card-body">
                <p className="capability-desc">{capability.description}</p>
                <p className="capability-when">
                  <span className="muted">何时使用：</span>
                  {capability.whenToUse}
                </p>

                <div className="capability-meta-row">
                  <span className="muted">Agent 工具：</span>
                  {capability.tools.length ? (
                    capability.tools.map((tool) => <span key={tool} className="badge write mono">{tool}</span>)
                  ) : (
                    <span className="muted">无 · 需要时引导用户到「工具箱 → {capability.title.zh}」</span>
                  )}
                </div>

                {isOpen ? (
                  <>
                    <div className="capability-flow">
                      <span className="muted">流程：</span>
                      <ol>
                        {capability.flow.map((step, index) => (
                          <li key={index}>{step}</li>
                        ))}
                      </ol>
                    </div>

                    <div className="capability-field-table">
                      <div className="capability-field-head">
                        <span>字段</span>
                        <span>类型</span>
                        <span>必填</span>
                        <span>默认 / 约束</span>
                        <span>说明</span>
                      </div>
                      {capability.fields.map((field) => (
                        <FieldRow key={field.key} field={field} />
                      ))}
                    </div>

                    <div className="capability-states">
                      <span className="muted">状态：</span>
                      {capability.states.map((state) => (
                        <span key={state.id} className="badge">
                          {state.id}
                          {state.terminal ? ' ✓' : ''}
                        </span>
                      ))}
                    </div>

                    {capability.constraints?.length ? (
                      <div className="capability-constraints">
                        <span className="muted">限制：</span>
                        <ul>
                          {capability.constraints.map((item, index) => (
                            <li key={index}>{item}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <div className="muted capability-foot">
        只读展示，不能逐个启停。可用性由权限模式、连接只读标记与功能总开关决定。契约文件：
        <span className="mono"> packages/core/src/capabilities/&lt;id&gt;.json</span>；设计见 docs/16-capability-contract.md。
      </div>
    </div>
  );
}

function FieldRow({ field }: { field: CapabilityField }) {
  const constraints: string[] = [];
  if (field.default !== undefined) constraints.push(`默认 ${JSON.stringify(field.default)}`);
  if (field.min !== undefined) constraints.push(`min ${field.min}`);
  if (field.max !== undefined) constraints.push(`max ${field.max}`);
  if (field.language) constraints.push(`语言 ${field.language}`);
  if (field.options?.length) constraints.push(`可选 ${field.options.map((option) => option.value).join(' / ')}`);
  if (field.allowAll) constraints.push('允许全部库');
  if (field.legacyKey) constraints.push(`别名 ${field.legacyKey}`);
  if (field.advanced) constraints.push('高级');
  if (field.showWhen) constraints.push(`仅当 ${field.showWhen.field}=${JSON.stringify(field.showWhen.equals)}`);
  if (field.signature) {
    constraints.push(`入参 ${field.signature.input ?? '-'} → 出参 ${field.signature.output ?? '-'}`);
  }

  return (
    <div className="capability-field-row" data-field={field.key}>
      <span className="mono">{field.key}</span>
      <span className="badge">{field.type}</span>
      <span>{field.required ? '✓' : ''}</span>
      <span className="muted">{constraints.join(' · ') || '—'}</span>
      <span className="muted">{field.hint ?? field.label.zh}</span>
    </div>
  );
}
