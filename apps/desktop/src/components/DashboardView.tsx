import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Eye, FileDown, Heart, LayoutDashboard, Pin, PinOff, Plus, RefreshCw, Sparkles, Trash2, X } from 'lucide-react';
import type { DashboardCard, DashboardCardResult, DashboardChartType, DashboardPreview, DashboardScheduleInfo, DashboardTimeRange } from '@aidb/core';
import { DASHBOARD_CHART_TYPES } from '@aidb/core';
import { api } from '../lib/api';
import { deliverExport } from '../lib/exportDelivery';
import { useApp, type Tab } from '../store';
import { ChartView } from './ChartView';
import { buildChartSpec, numericColumnNames, type ChartDataset } from './buildChartSpec';
import { DatabaseSelect } from './DatabaseSelect';
import { Option, Select, Spinner } from './ui';
import { t as tr } from '../i18n';

type DashboardTab = Extract<Tab, { kind: 'dashboard' }>;

const CHART_LABELS: Record<DashboardChartType, string> = {
  bar: tr("柱状图"),
  stacked: tr("堆叠柱状图"),
  line: tr("折线图"),
  pie: tr("饼图"),
  scatter: tr("散点图"),
  heatmap: tr("热力图"),
  radar: tr("雷达图"),
};

const RANGES: Array<{ value: string; label: string; days?: number }> = [
  { value: 'all', label: tr("全部时间") },
  { value: '7d', label: tr("近 7 天"), days: 7 },
  { value: '30d', label: tr("近 30 天"), days: 30 },
  { value: '90d', label: tr("近 90 天"), days: 90 },
  { value: '365d', label: tr("近 1 年"), days: 365 },
];

/** 定时刷新默认关闭：后台默默跑查询对生产库是风险，必须逐板显式开。 */
const SCHEDULES: Array<{ value: number; label: string }> = [
  { value: 0, label: tr("不定时刷新") },
  { value: 300, label: tr("每 5 分钟") },
  { value: 1800, label: tr("每 30 分钟") },
  { value: 7200, label: tr("每 2 小时") },
  { value: 86400, label: tr("每天") },
];

function timeRangeOf(value: string): DashboardTimeRange | undefined {
  const preset = RANGES.find((item) => item.value === value);
  if (!preset?.days) return undefined;
  const day = 86_400_000;
  const from = new Date(Date.now() - (preset.days - 1) * day);
  const to = new Date(Date.now() + day);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

interface DraftCard {
  title: string;
  sql: string;
  chartType: DashboardChartType;
  x?: string;
  y?: string;
  timeColumn?: string;
  source: 'ai' | 'manual';
}

function emptyDraft(): DraftCard {
  return { title: '', sql: '', chartType: 'bar', source: 'manual' };
}

interface CardSpecInput {
  title: string;
  sql?: string;
  chartType: DashboardChartType;
  x?: string;
  y?: string;
}

/**
 * 卡片与新建预览共用同一套出图规则：多度量尽量都画，量纲差 10 倍切双轴。
 * 两处各写一份就会出现「预览一根线、保存后两根线」。
 */
function buildCardSpec(input: CardSpecInput, data: ChartDataset | null | undefined) {
  if (!data) return null;
  const dataset = data.statement || !input.sql ? data : { ...data, statement: input.sql };
  const numeric = numericColumnNames(dataset);
  const y = input.y ?? numeric[0];
  const magnitude = (name: string) => {
    const index = dataset.columns.findIndex((column) => column.name === name);
    return Math.max(0, ...dataset.rows.map((row) => Math.abs(Number(row[index])) || 0));
  };
  const primaryMax = magnitude(y);
  const candidates = numeric.filter((name) => name !== y && name !== input.x).slice(0, 2);
  const mismatched = candidates.filter((name) => {
    const other = magnitude(name);
    if (other === 0 || primaryMax === 0) return false;
    return Math.max(other, primaryMax) / Math.min(other, primaryMax) >= 10;
  });
  const dual = mismatched.length === 1 && candidates.length === 1;
  const extraY = dual ? candidates : candidates.filter((name) => !mismatched.includes(name));
  const type: DashboardChartType = dual && input.chartType === 'line' ? 'bar' : input.chartType;
  return buildChartSpec({
    data: dataset,
    type,
    x: input.x,
    y,
    extraY,
    dualAxis: dual,
    title: input.title,
  });
}

/** 历史条目的 status 在服务端是宽字符串，这里只关心能不能钉。 */
interface FavoriteItem {
  id: string;
  sql: string;
  status: string;
  database?: string;
  favorite?: boolean;
}

function favoriteTitle(sql: string): string {
  const comment = /^\s*(?:--|\/\*)\s*(.+)$/m.exec(sql);
  const name = comment?.[1]?.trim();
  if (name && name.length <= 40) return name;
  const first = sql.replace(/\s+/g, ' ').trim();
  return first.slice(0, 36) + (first.length > 36 ? '…' : '');
}

function DashboardCardView({
  card,
  limit,
  busy,
  rangeActive,
  onRefresh,
  onDelete,
  onPatch,
  onMove,
  onOpenSql,
}: {
  card: DashboardCard;
  limit: number;
  busy: boolean;
  rangeActive: boolean;
  onRefresh: () => void;
  onDelete: () => void;
  onPatch: (patch: Partial<DashboardCard>) => void;
  onMove: (direction: -1 | 1) => void;
  onOpenSql: () => void;
}) {
  const spec = useMemo(
    () =>
      buildCardSpec(
        { title: card.title, sql: card.sql, chartType: card.chartType, x: card.x, y: card.y },
        card.lastResult,
      ),
    [card.lastResult, card.chartType, card.sql, card.x, card.y, card.title],
  );
  const columns = card.lastResult?.columns.map((column) => column.name) ?? [];

  return (
    <div className={`dash-card ${card.span === 2 ? 'wide' : ''}`} data-testid="dashboard-card" data-pinned={card.pinned ? '1' : '0'}>
      <div className="dash-card-body">
        {spec ? (
          <ChartView
            chart={spec}
            height={300}
            enforceSuitability
            maxPoints={card.span === 2 ? 24 : 12}
            onTypeChange={(type) => onPatch({ chartType: type as DashboardChartType })}
            onOpenEditor={onOpenSql}
          />
        ) : (
          <div className="dash-card-empty">
            <div>{card.title}</div>
            <div className="dash-card-empty-hint">
              {card.lastStatus === 'error'
                ? card.lastError || tr("查询失败")
                : card.lastRunAt
                  ? tr("这条查询返回 0 行（时间范围内没有数据？）")
                  : tr("还没有结果，点刷新执行这条查询")}
            </div>
            <code className="dash-card-sql">{card.sql}</code>
          </div>
        )}
      </div>
      <div className="dash-card-foot">
        <span className={`dash-tag ${card.source === 'ai' ? 'ai' : ''}`}>
          {card.source === 'ai' ? (card.pinned ? tr("AI · 已固定") : tr("AI 草稿")) : card.source === 'favorite' ? tr("收藏") : tr("手动")}
        </span>
        {card.lastRunAt ? (
          <span className="dash-meta mono" title={tr("上次刷新 {0}", [card.lastRunAt])}>
            {card.lastStatus === 'error' ? tr("失败") : tr("已刷新")}
            {rangeActive && card.timeColumn ? (card.lastError ? tr(" · 筛选未生效") : tr(" · 已筛选")) : null}
          </span>
        ) : null}
        <span className="dash-foot-space" />
        {columns.length > 1 ? (
          <Select
            className="select dash-time"
            value={card.timeColumn ?? ''}
            title={tr("时间列：板级时间范围只作用于标了时间列的卡片")}
            onChange={(event) => onPatch({ timeColumn: event.target.value })}
            data-testid="dashboard-card-time"
          >
            <Option value="">{tr("不参与时间筛选")}</Option>
            {columns.map((name) => (
              <Option key={name} value={name}>
                {tr(" 时间列：")}{name}
              </Option>
            ))}
          </Select>
        ) : null}
        <button className="icon-btn" title={tr("刷新此卡片")} onClick={onRefresh} disabled={busy} data-testid="dashboard-card-refresh">
          {busy ? <Spinner /> : <RefreshCw size={12} />}
        </button>
        <button
          className="icon-btn"
          title={card.pinned ? tr("取消固定（可被 AI 草稿替换）") : tr("固定（AI 生成不会覆盖）")}
          onClick={() => onPatch({ pinned: !card.pinned })}
          data-testid="dashboard-card-pin"
        >
          {card.pinned ? <PinOff size={12} /> : <Pin size={12} />}
        </button>
        <button className="icon-btn" title={card.span === 2 ? tr("变窄") : tr("加宽")} onClick={() => onPatch({ span: card.span === 2 ? 1 : 2 })} data-testid="dashboard-card-span">
          {card.span === 2 ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
        <button className="icon-btn" title={tr("前移")} onClick={() => onMove(-1)} disabled={card.position <= 1}>
          <ChevronUp size={12} />
        </button>
        <button className="icon-btn" title={tr("后移")} onClick={() => onMove(1)} disabled={card.position >= limit}>
          <ChevronDown size={12} />
        </button>
        <button className="icon-btn danger" title={tr("从仪表板移除")} onClick={onDelete} data-testid="dashboard-card-delete">
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}

function PreviewTable({ preview }: { preview: DashboardPreview }) {
  const columns = preview.columns.slice(0, 6);
  const rows = preview.rows.slice(0, 6);
  const text = (value: unknown) => {
    if (value === null || value === undefined) return '—';
    if (typeof value === 'object') return JSON.stringify(value).slice(0, 80);
    return String(value);
  };
  return (
    <div className="dash-preview-table-wrap">
      <table className="dash-preview-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.name}>{column.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column, columnIndex) => (
                <td key={`${index}-${column.name}`}>{text(row[columnIndex])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length ? <div className="dash-preview-empty">{tr("查询返回 0 行")}</div> : null}
    </div>
  );
}

export function DashboardView({ tab }: { tab: DashboardTab }) {
  const connections = useApp((s) => s.connections);
  const openQuery = useApp((s) => s.openQuery);
  const updateTab = useApp((s) => s.updateTab);
  const notify = useApp((s) => s.notify);
  const rangeByScope = useApp((s) => s.dashboardRange);
  const setDashboardRange = useApp((s) => s.setDashboardRange);

  const [cards, setCards] = useState<DashboardCard[]>([]);
  const [limit, setLimit] = useState(12);
  const [supported, setSupported] = useState(true);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [pending, setPending] = useState<string[]>([]);
  const [composerOpen, setComposerOpen] = useState(false);
  const [draft, setDraft] = useState<DraftCard>(emptyDraft);
  const [requirement, setRequirement] = useState('');
  const [composing, setComposing] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<(DashboardPreview & { sql: string }) | null>(null);
  const [composeNotes, setComposeNotes] = useState<string[]>([]);
  const [composeError, setComposeError] = useState('');
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  const [favorites, setFavorites] = useState<FavoriteItem[]>([]);
  const [favoritesLoading, setFavoritesLoading] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [schedule, setSchedule] = useState<DashboardScheduleInfo | null>(null);

  const conn = useMemo(() => connections.find((item) => item.id === tab.connectionId), [connections, tab.connectionId]);
  const database = tab.database ?? conn?.database;
  const scopeKey = `${tab.connectionId}/${database ?? ''}`;
  const rangeValue = rangeByScope[scopeKey] ?? 'all';
  const drafts = cards.filter((card) => !card.pinned).length;

  const load = useCallback(async () => {
    if (!conn) return;
    setLoading(true);
    try {
      const response = await api.dashboardCards({ connectionId: conn.id, database });
      setCards(response.cards);
      setLimit(response.limit);
      setSupported(response.supported);
      setSchedule((await api.dashboardSchedule({ connectionId: conn.id, database }).catch(() => ({ schedule: null })))?.schedule ?? null);
    } catch (err: any) {
      notify('error', tr("读取仪表板失败"), err?.message);
    } finally {
      setLoading(false);
    }
  }, [conn, database, notify]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(
    async (cardIds?: string[]) => {
      if (!conn) return;
      setRefreshing(true);
      setPending(cardIds ?? cards.map((card) => card.id));
      try {
        const response = await api.dashboardRefresh({ connectionId: conn.id, database, cardIds, range: timeRangeOf(rangeValue) });
        setCards(response.cards);
        const failed = response.results.filter((result: DashboardCardResult) => result.status === 'error');
        if (failed.length) notify('warning', tr("{0} 张卡片刷新失败", [failed.length]), failed[0].error);
        const skipped = response.results.filter((result: DashboardCardResult) => result.filterSkipped);
        if (skipped.length) notify('info', tr("时间范围对部分卡片未生效"), tr("{0} 张卡片的结果里没有那一列，已按原查询展示", [skipped.length]));
      } catch (err: any) {
        notify('error', tr("刷新失败"), err?.message);
      } finally {
        setRefreshing(false);
        setPending([]);
      }
    },
    [conn, database, cards, rangeValue, notify],
  );

  // 先用落库快照秒渲染，再后台补一次真实数据；单卡失败不挡整板。
  const [booted, setBooted] = useState(false);
  useEffect(() => {
    setBooted(false);
  }, [scopeKey]);
  useEffect(() => {
    if (loading || !cards.length || booted) return;
    setBooted(true);
    void refresh();
  }, [loading, cards, booted, refresh]);

  // 换时间范围要立刻重算，但只在用户真的换了之后；booted 的首刷不算。
  const lastRange = useRef(rangeValue);
  useEffect(() => {
    if (lastRange.current === rangeValue) return;
    lastRange.current = rangeValue;
    if (cards.length) void refresh();
  }, [rangeValue, cards.length, refresh]);

  const saveCard = useCallback(
    async (input: {
      id?: string;
      title: string;
      sql: string;
      chartType: DashboardChartType;
      x?: string;
      y?: string;
      span?: 1 | 2;
      pinned?: boolean;
      timeColumn?: string;
      source?: 'ai' | 'favorite' | 'manual';
    }) => {
      if (!conn) return undefined;
      try {
        const response = await api.dashboardSaveCard({
          id: input.id,
          connectionId: conn.id,
          database,
          title: input.title,
          sql: input.sql,
          chartType: input.chartType,
          x: input.x,
          y: input.y,
          span: input.span,
          pinned: input.pinned,
          timeColumn: input.timeColumn,
          source: input.source,
        });
        setCards(response.cards);
        return response.card;
      } catch (err: any) {
        notify('error', tr("卡片保存失败"), err?.message);
        return undefined;
      }
    },
    [conn, database, notify],
  );

  const patchCard = (card: DashboardCard, patch: Partial<DashboardCard>) =>
    void saveCard({
      id: card.id,
      title: patch.title ?? card.title,
      sql: patch.sql ?? card.sql,
      chartType: (patch.chartType ?? card.chartType) as DashboardChartType,
      span: patch.span ?? card.span,
      pinned: patch.pinned ?? card.pinned,
      timeColumn: patch.timeColumn === undefined ? card.timeColumn : patch.timeColumn,
    });

  const addCard = async () => {
    const sql = draft.sql.trim();
    if (!sql) {
      notify('warning', tr("请先写查询或让 AI 生成一版"));
      return;
    }
    const card = await saveCard({
      title: draft.title.trim() || favoriteTitle(sql),
      sql,
      chartType: draft.chartType,
      x: draft.x,
      y: draft.y,
      timeColumn: draft.timeColumn,
      pinned: true,
      source: draft.source,
    });
    if (card) {
      setDraft(emptyDraft());
      setRequirement('');
      setPreview(null);
      setComposeNotes([]);
      setComposeError('');
      setComposerOpen(false);
      void refresh([card.id]);
    }
  };

  // 需求 → 只读聚合 SQL → 当前库试跑。生成失败和试跑失败都留在表单里，不弹走上下文。
  const composeCard = async () => {
    if (!conn) return;
    const prompt = requirement.trim();
    if (!prompt) {
      notify('warning', tr("先写一句需求"), tr("例如：近 30 天每天的订单量和成交额"));
      return;
    }
    setComposing(true);
    setComposeError('');
    try {
      const result = await api.dashboardCompose({ connectionId: conn.id, database, prompt });
      setDraft({
        title: result.title,
        sql: result.sql,
        chartType: result.chartType,
        x: result.x,
        y: result.y,
        timeColumn: result.timeColumn,
        source: 'ai',
      });
      setPreview({ sql: result.sql, ...result.preview });
      setComposeNotes(result.notes);
      if (result.preview.error) notify('warning', tr("SQL 已生成，但试跑未通过"), result.preview.error);
      else notify('success', result.usedModel ? tr("AI 已生成 SQL，试跑通过") : tr("已按内置口径生成 SQL，试跑通过"));
    } catch (err: any) {
      setComposeError(err?.message ?? tr("生成失败"));
      setComposeNotes([]);
    } finally {
      setComposing(false);
    }
  };

  // 手动改过 SQL 之后单独跑一次预览，口径不放心可以先看数据再保存。
  const previewCard = async () => {
    if (!conn) return;
    const sql = draft.sql.trim();
    if (!sql) {
      notify('warning', tr("SQL 为空"), tr("先写查询，或让 AI 生成一版"));
      return;
    }
    setPreviewing(true);
    setComposeError('');
    try {
      const { preview: result } = await api.dashboardPreview({ connectionId: conn.id, database, sql });
      setPreview({ sql, ...result });
      setComposeNotes([]);
      if (result.error) notify('warning', tr("预览失败"), result.error);
    } catch (err: any) {
      setComposeError(err?.message ?? tr("预览失败"));
    } finally {
      setPreviewing(false);
    }
  };

  const previewSpec = useMemo(() => {
    if (!preview || preview.error) return null;
    return buildCardSpec(
      { title: draft.title.trim() || tr("查询预览"), sql: preview.sql, chartType: draft.chartType, x: draft.x, y: draft.y },
      { columns: preview.columns, rows: preview.rows, statement: preview.sql },
    );
  }, [preview, draft.title, draft.chartType, draft.x, draft.y]);
  const previewStale = Boolean(preview && !preview.error && draft.sql.trim() !== preview.sql.trim());

  const generate = async () => {
    if (!conn) return;
    setGenerating(true);
    try {
      const response = await api.dashboardGenerate({ connectionId: conn.id, database });
      setCards(response.cards);
      if (!response.created) notify('warning', tr("没有生成新草稿"), response.notes[0] ?? tr("候选都已被固定或试跑未通过"));
      else notify('success', tr("已生成 {0} 张草稿卡片", [response.created]), response.notes[0] ?? (response.usedModel ? tr("按库结构与口径挑选，试跑通过") : ''));
    } catch (err: any) {
      notify('error', tr("生成草稿失败"), err?.message);
    } finally {
      setGenerating(false);
    }
  };

  // 仪表板是活查询，报告是一次快照：导出走现成的 deck 渲染，不自己画分页。
  const exportReport = async () => {
    if (!conn) return;
    setExporting(true);
    try {
      const { artifact } = await api.dashboardReport({ connectionId: conn.id, database });
      const file = await api.exportArtifact(artifact.id, 'pptx');
      await deliverExport(file, tr("仪表板报告已导出"));
    } catch (err: any) {
      notify('error', tr("导出报告失败"), err?.message);
    } finally {
      setExporting(false);
    }
  };

  const discardDrafts = async () => {    if (!conn) return;
    try {
      const response = await api.dashboardDiscardDrafts({ connectionId: conn.id, database });
      setCards(response.cards);
      notify('success', tr("已丢弃 {0} 张草稿", [response.discarded]));
    } catch (err: any) {
      notify('error', tr("丢弃草稿失败"), err?.message);
    }
  };

  const openFavorites = async () => {
    if (!conn) return;
    setFavoritesOpen(true);
    setFavoritesLoading(true);
    try {
      const response = await api.history({ connectionId: conn.id, limit: 200 });
      setFavorites(response.items.filter((item) => item.favorite && item.status === 'ok'));
    } catch (err: any) {
      notify('error', tr("读取收藏失败"), err?.message);
    } finally {
      setFavoritesLoading(false);
    }
  };

  const importFavorites = async () => {
    const chosen = favorites.filter((item) => picked.includes(item.id));
    if (!chosen.length) {
      notify('warning', tr("先勾选要钉上来的收藏查询"));
      return;
    }
    for (const item of chosen) {
      const card = await saveCard({ title: favoriteTitle(item.sql), sql: item.sql, chartType: 'bar', pinned: true, source: 'favorite' });
      if (card) void refresh([card.id]);
    }
    setPicked([]);
    setFavoritesOpen(false);
    notify('success', tr("已钉上来 {0} 张卡片", [chosen.length]));
  };

  const move = async (card: DashboardCard, direction: -1 | 1) => {
    const sorted = [...cards].sort((a, b) => a.position - b.position);
    const index = sorted.findIndex((item) => item.id === card.id);
    const target = index + direction;
    if (target < 0 || target >= sorted.length) return;
    const order = sorted.map((item) => item.id);
    [order[index], order[target]] = [order[target], order[index]];
    try {
      const response = await api.dashboardReorderCards(order);
      setCards(response.cards);
    } catch (err: any) {
      notify('error', tr("排序失败"), err?.message);
    }
  };

  return (
    <section className="dash-view" data-testid="dashboard-view">
      <header className="dash-head">
        <div className="dash-title">
          <LayoutDashboard size={14} />
          <span>{tr("仪表板")}</span>
          <DatabaseSelect connectionId={tab.connectionId} value={database ?? ''} onChange={(value) => updateTab(tab.id, { database: value })} testId="dashboard-database" />
        </div>
        <div className="dash-actions">
          <span className="dash-meta mono">
            {cards.length} / {limit}
          </span>
          {cards.some((card) => card.timeColumn) ? (
            <Select
              className="select"
              value={rangeValue}
              title={tr("板级时间范围：只作用于标了时间列的卡片")}
              onChange={(event) => {
                setDashboardRange(scopeKey, event.target.value);
              }}
              data-testid="dashboard-range"
            >
              {RANGES.map((item) => (
                <Option key={item.value} value={item.value}>
                  {item.label}
                </Option>
              ))}
            </Select>
          ) : null}
          <Select
            className="select"
            value={String(schedule?.intervalSeconds ?? 0)}
            title={
              schedule?.intervalSeconds
                ? tr("后台定时刷新已开启{0}", [schedule.lastRunAt ? tr("，上次 {0}{1}", [schedule.lastRunAt, schedule.lastError ? ` · ${schedule.lastError}` : '']) : ''])
                : tr("定时刷新默认关闭：后台跑查询对生产库是风险，需要逐板显式开启")
            }
            onChange={(event) => {
              const intervalSeconds = Number(event.target.value);
              void api
                .dashboardSetSchedule({ connectionId: tab.connectionId, database, intervalSeconds })
                .then((response) => {
                  setSchedule(response.schedule);
                  notify(
                    'success',
                    intervalSeconds ? tr("已开启定时刷新：{0}", [SCHEDULES.find((item) => item.value === intervalSeconds)?.label]) : tr("已关闭定时刷新"),
                  );
                })
                .catch((err: any) => notify('error', tr("定时刷新设置失败"), err?.message));
            }}
            data-testid="dashboard-schedule"
          >
            {SCHEDULES.map((item) => (
              <Option key={item.value} value={item.value}>
                {item.label}
              </Option>
            ))}
          </Select>
          <button className="btn small" onClick={() => void refresh()} disabled={refreshing || !cards.length} data-testid="dashboard-refresh">
            {refreshing ? <Spinner /> : <RefreshCw size={12} />}{tr(" 刷新 ")}</button>
          <button className="btn small" onClick={openFavorites} disabled={!supported} data-testid="dashboard-favorites">
            <Heart size={12} /> {tr(" 从收藏导入 ")}</button>
          <button className="btn small" onClick={() => setComposerOpen((open) => !open)} disabled={!supported} data-testid="dashboard-add">
            <Plus size={12} /> {tr(" 新建卡片 ")}</button>
          <button className="btn small primary" onClick={generate} disabled={generating || !supported} data-testid="dashboard-generate">
            {generating ? <Spinner /> : <Sparkles size={12} />}{tr(" 让 AI 补一批 ")}</button>
          <button
            className="btn small"
            onClick={exportReport}
            disabled={exporting || !cards.length}
            title={tr("把当前结果整理成可汇报的分页报告（PPTX）")}
            data-testid="dashboard-export-report"
          >
            {exporting ? <Spinner /> : <FileDown size={12} />}{tr(" 导出为报告 ")}</button>
          {drafts ? (
            <button className="icon-btn" title={tr("丢弃 {0} 张草稿（固定卡片不动）", [drafts])} onClick={discardDrafts} data-testid="dashboard-discard">
              <X size={13} />
            </button>
          ) : null}
        </div>
      </header>

      {composerOpen ? (
        <div className="dash-composer panel" data-testid="dashboard-composer">
          <div className="dash-compose-ai">
            <Sparkles size={13} className="dash-ai-icon" />
            <input
              className="input"
              placeholder={tr("一句话说清想看的指标，例如：近 30 天每天的订单量和成交额")}
              value={requirement}
              onChange={(event) => setRequirement(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !composing) void composeCard();
              }}
              data-testid="dashboard-card-prompt"
            />
            <button className="btn small primary" onClick={() => void composeCard()} disabled={composing || !requirement.trim()} data-testid="dashboard-card-compose">
              {composing ? <Spinner /> : <Sparkles size={12} />} {composing ? tr("生成中…") : tr("AI 生成并预览")}
            </button>
          </div>
          <div className="dash-ai-hint">{tr("AI 只写单条只读聚合查询，先在当前库试跑 200 行；生成后仍可直接改 SQL。")}</div>
          <input
            className="input"
            placeholder={tr("卡片标题，例如 近 30 天日订单量")}
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            data-testid="dashboard-card-title"
          />
          <textarea
            className="input mono dash-sql"
            rows={4}
            placeholder="SELECT ...（只允许查询语句）"
            value={draft.sql}
            onChange={(event) => setDraft({ ...draft, sql: event.target.value })}
            data-testid="dashboard-card-sql"
          />
          {composeError ? (
            <div className="dash-preview-error" data-testid="dashboard-card-compose-error">
              {composeError}
            </div>
          ) : null}
          {preview ? (
            <div className="dash-preview" data-testid="dashboard-card-preview">
              <div className="dash-preview-head">
                <span className={`dash-tag ${draft.source === 'ai' ? 'ai' : ''}`}>{draft.source === 'ai' ? tr("AI 预览") : tr("预览")}</span>
                <span className="dash-meta">
                  {preview.error ? tr("试跑失败") : tr("{0} 行 · {1} ms", [preview.rowCount, preview.durationMs])}
                  {preview.truncated ? tr(" · 仅前 200 行") : ''}
                </span>
                {previewStale ? <span className="dash-preview-stale">{tr("SQL 已修改，重新预览后为准")}</span> : null}
                <span className="dash-foot-space" />
                <button
                  className="icon-btn"
                  title={tr("收起预览")}
                  onClick={() => {
                    setPreview(null);
                    setComposeNotes([]);
                  }}
                >
                  <X size={12} />
                </button>
              </div>
              {preview.error ? (
                <div className="dash-preview-error" data-testid="dashboard-card-preview-error">
                  {preview.error}
                </div>
              ) : previewSpec ? (
                <ChartView
                  chart={previewSpec}
                  height={220}
                  enforceSuitability
                  maxPoints={24}
                  onTypeChange={(type) => setDraft((current) => ({ ...current, chartType: type as DashboardChartType }))}
                />
              ) : (
                <PreviewTable preview={preview} />
              )}
              {composeNotes.length ? (
                <div className="dash-preview-note" data-testid="dashboard-card-compose-notes">
                  {composeNotes.join(' · ')}
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="dash-composer-foot">
            <Select className="select" value={draft.chartType} onChange={(event) => setDraft({ ...draft, chartType: event.target.value as DashboardChartType })} data-testid="dashboard-card-type">
              {DASHBOARD_CHART_TYPES.map((type) => (
                <Option key={type} value={type}>
                  {CHART_LABELS[type]}
                </Option>
              ))}
            </Select>
            <span className="dash-foot-space" />
            <button className="btn small" onClick={() => void previewCard()} disabled={previewing || !draft.sql.trim()} data-testid="dashboard-card-preview-btn">
              {previewing ? <Spinner /> : <Eye size={12} />}{tr(" 预览 ")}</button>
            <button className="btn small primary" onClick={addCard} data-testid="dashboard-card-save">
              {tr(" 保存到仪表板 ")}</button>
            <button className="icon-btn" title={tr("收起")} onClick={() => setComposerOpen(false)}>
              <X size={12} />
            </button>
          </div>
        </div>
      ) : null}

      {favoritesOpen ? (
        <div className="dash-composer panel" data-testid="dashboard-favorites-dialog">
          <div className="dash-favorites-head">
            <strong>{tr("收藏的 SQL")}</strong>
            <span className="dash-meta">{tr("挑几个钉到看板上——比让 AI 猜你的口径更准。")}</span>
            <span className="dash-foot-space" />
            <button className="btn small" onClick={importFavorites} data-testid="dashboard-favorites-import">
              {tr(" 钉上来 ")}{picked.length ? `(${picked.length})` : ''}
            </button>
            <button className="icon-btn" title={tr("关闭")} onClick={() => setFavoritesOpen(false)}>
              <X size={12} />
            </button>
          </div>
          {favoritesLoading ? (
            <div className="dash-empty">
              <Spinner /> {tr(" 正在读取收藏的查询… ")}</div>
          ) : !favorites.length ? (
            <div className="dash-empty">{tr("还没有收藏的查询。在查询编辑器里点星标即可收藏。")}</div>
          ) : null}
          {favorites.map((item) => (
            <label key={item.id} className="dash-favorite">
              <input
                type="checkbox"
                checked={picked.includes(item.id)}
                onChange={(event) => setPicked(event.target.checked ? [...picked, item.id] : picked.filter((id) => id !== item.id))}
              />
              <code className="mono">{item.sql.replace(/\s+/g, ' ').slice(0, 140)}</code>
            </label>
          ))}
        </div>
      ) : null}

      {loading ? (
        <div className="dash-loading">
          <Spinner /> {tr(" 正在读取仪表板… ")}</div>
      ) : !supported ? (
        <div className="dash-empty panel">
          <strong>{conn ? conn.name : tr("未选择连接")}</strong> {tr(" 不是 SQL 系引擎，仪表板只面向查询类数据源。 ")}</div>
      ) : !cards.length ? (
        <div className="dash-empty panel" data-testid="dashboard-empty">
          <strong>{tr("这块板还是空的。")}</strong>
          <p>
            {tr(" 仪表板属于「")}{database ? database.split(/[\\/]+/).filter(Boolean).pop() : tr("默认库")}{tr("」这一个库——每个库的重点不一样，卡片也各管各的。 可以让 AI 按库结构与口径生成一版草稿，或把收藏的查询钉上来，也可以自己写 SQL。 ")}</p>
          <div className="dash-empty-actions">
            <button className="btn small primary" onClick={generate} disabled={generating} data-testid="dashboard-empty-generate">
              {generating ? <Spinner /> : <Sparkles size={12} />}{tr(" 让 AI 生成草稿 ")}</button>
            <button className="btn small" onClick={openFavorites} data-testid="dashboard-empty-favorites">
              <Heart size={12} /> {tr(" 从收藏导入 ")}</button>
            <button className="btn small" onClick={() => setComposerOpen(true)} data-testid="dashboard-empty-add">
              <Plus size={12} /> {tr(" 新建卡片 ")}</button>
          </div>
        </div>
      ) : (
        <div className="dash-grid" data-testid="dashboard-grid">
          {[...cards]
            .sort((a, b) => a.position - b.position)
            .map((card) => (
              <DashboardCardView
                key={card.id}
                card={card}
                limit={limit}
                busy={pending.includes(card.id)}
                rangeActive={!!timeRangeOf(rangeValue)}
                onRefresh={() => void refresh([card.id])}
                onDelete={() => void (async () => {
                  try {
                    const response = await api.dashboardDeleteCard(card.id);
                    setCards(response.cards);
                  } catch (err: any) {
                    notify('error', tr("删除失败"), err?.message);
                  }
                })()}
                onPatch={(patch) => patchCard(card, patch)}
                onMove={(direction) => void move(card, direction)}
                onOpenSql={() => openQuery(card.connectionId, card.sql, card.title, card.database)}
              />
            ))}
        </div>
      )}
    </section>
  );
}
