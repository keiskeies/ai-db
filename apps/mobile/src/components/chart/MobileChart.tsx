import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import Svg, { Circle, Line, Path, Polyline, Rect, Text as SvgText } from 'react-native-svg';
import { Loader2, Sparkles, TrendingUp, X } from 'lucide-react-native';
import { chartSuitability, type ChartKind } from '@aidb/core';
import { colors, heatTone } from '../../theme';
import { translate } from '../../i18n';
import { styles } from '../../styles';
import { Text } from '../base';
import { ChartInsightContext } from './ChartInsightContext';
import { CHART_COLORS, CHART_TYPES, normalizeChartType, chartLabelWidth, fitChartLabel, compactNumber, formatMetric, type ChartSelection, type MobileInsightAnalysis, type ChartShape } from './model';

export function MobileChart({ chart: sourceChart, insight, allowTypeSwitch = true }: { chart: ChartShape; insight?: { connectionId: string; database?: string }; allowTypeSwitch?: boolean }) {
  const insightCtx = React.useContext(ChartInsightContext);
  const insightScope = insight ?? (insightCtx?.connectionId ? { connectionId: insightCtx.connectionId, database: insightCtx.database } : undefined);
  const canInsight = Boolean(insightCtx?.client && insightScope?.connectionId && sourceChart.sql);
  const [selection, setSelection] = React.useState<ChartSelection | null>(null);
  const [analysis, setAnalysis] = React.useState<MobileInsightAnalysis | null>(null);
  const [forecastOverlay, setForecastOverlay] = React.useState<{ forecast: NonNullable<ChartShape['forecast']>; note?: string } | null>(null);
  const [insightBusy, setInsightBusy] = React.useState<'analyze' | 'forecast' | null>(null);
  const [insightError, setInsightError] = React.useState<string | null>(null);
  // 预测段合并进显示用 chart；移动端已渲染虚线 + 区间带，零新渲染代码
  const chart = forecastOverlay ? { ...sourceChart, forecast: forecastOverlay.forecast, note: forecastOverlay.note ?? sourceChart.note } : sourceChart;
  const [typeState, setType] = React.useState<ChartKind>(() => normalizeChartType(sourceChart.type));
  const type: ChartKind = forecastOverlay ? 'line' : typeState;
  const fit = React.useMemo(
    () => chartSuitability({ series: chart.series, extraSeries: chart.extraSeries, scatter: chart.scatter, heatmap: chart.heatmap, forecast: chart.forecast }),
    [chart],
  );
  const insightKey = `${insightScope?.connectionId ?? ''}|${insightScope?.database ?? ''}|${sourceChart.sql ?? ''}`;
  React.useEffect(() => {
    setAnalysis(null);
    setForecastOverlay(null);
    setInsightError(null);
  }, [insightKey]);
  const runInsight = async (mode: 'analyze' | 'forecast') => {
    if (!insightCtx?.client || !insightScope?.connectionId || !sourceChart.sql) return;
    if (mode === 'analyze' && analysis) { setAnalysis(null); return; }
    if (mode === 'forecast' && forecastOverlay) { setForecastOverlay(null); return; }
    setInsightBusy(mode);
    setInsightError(null);
    try {
      const { result } = await insightCtx.client.chartInsight({ connectionId: insightScope.connectionId, database: insightScope.database, sql: sourceChart.sql, x: sourceChart.xLabel, y: sourceChart.yLabel, mode });
      if (!result.ok) { setInsightError(result.error?.message ?? result.summary); return; }
      if (mode === 'analyze') {
        setAnalysis(result.data as MobileInsightAnalysis);
      } else {
        const data = result.data as { chart?: { forecast?: NonNullable<ChartShape['forecast']>; note?: string } };
        if (data.chart?.forecast?.length) setForecastOverlay({ forecast: data.chart.forecast, note: data.chart.note });
        else setInsightError(result.summary);
      }
    } catch (err) {
      setInsightError(err instanceof Error ? err.message : String(err));
    } finally {
      setInsightBusy(null);
    }
  };
  const W = 320;
  const H = 168;
  const padLeft = 38;
  const padRight = 8;
  const padTop = 10;
  const innerW = W - padLeft - padRight;
  const palette = CHART_COLORS;
  const toggleSelection = (next: ChartSelection) => {
    setSelection((prev) => (prev && prev.label === next.label && prev.index === next.index ? null : next));
  };
  const history = (chart.series ?? []).slice(0, 24);
  const valuesOf = (list: Array<{ value: number }>) => list.map((point) => Number(point.value) || 0);
  const hasBaseline = history.some((point) => typeof point.baseline === 'number');
  const columns = [
    { name: chart.yLabel || '值', values: valuesOf(history), color: palette[0] },
    ...(hasBaseline
      ? [{ name: chart.baselineName || translate('上期'), values: history.map((point) => Number(point.baseline) || 0), color: palette[1] }]
      : []),
    ...(chart.extraSeries ?? [])
      .filter((extra) => Array.isArray(extra.values) && extra.values.length >= history.length && history.length > 0)
      .slice(0, 4)
      .map((extra, index) => ({ name: extra.name, values: extra.values.slice(0, history.length).map((value) => Number(value) || 0), color: palette[(index + (hasBaseline ? 2 : 1)) % palette.length] })),
  ];
  const isBar = type === 'bar' || type === 'stacked';
  const stacked = isBar && columns.length > 1 && (type === 'stacked' || chart.stacked === true);
  const dual = isBar && chart.dualAxis === true && columns.length > 1 && !stacked;
  const forecast = type === 'line' ? (chart.forecast ?? []).slice(0, 12) : [];
  const labels = [...history.map((point) => String(point.label)), ...forecast.map((point) => String(point.label))];
  const primary = columns[0]?.values ?? [];

  // 横轴标签：放不下就统一倾斜；倾斜后仍会压字时才隔几个显示。
  const labelWidths = labels.map((label) => chartLabelWidth(label, 8));
  const bandEstimate = innerW / Math.max(1, labels.length);
  const rotateLabels = labels.length > 1 && Math.max(0, ...labelWidths) > bandEstimate - 6;
  const sinAngle = Math.sin((40 * Math.PI) / 180);
  const labelStep = rotateLabels ? Math.max(1, Math.ceil(8 / Math.max(1, bandEstimate * sinAngle))) : 1;
  const padBottom = rotateLabels ? Math.min(56, Math.max(32, Math.round(12 + Math.max(0, ...labelWidths) * sinAngle))) : 22;
  const innerH = H - padTop - padBottom;

  const bounds: number[] = [...primary, ...forecast.map((point) => Number(point.value) || 0)];
  if (stacked) {
    for (let index = 0; index < primary.length; index += 1) {
      let positive = 0;
      let negative = 0;
      for (const column of columns) {
        const value = column.values[index] ?? 0;
        if (value >= 0) positive += value;
        else negative += value;
      }
      bounds.push(positive, negative);
    }
  } else if (!dual) {
    for (const column of columns.slice(1)) bounds.push(...column.values);
  }
  for (const point of forecast) bounds.push(Number(point.lower) || 0, Number(point.upper) || 0);

  const hi = Math.max(1, ...bounds);
  const lo = Math.min(0, ...bounds);
  const span = hi - lo || 1;
  const y = (value: number) => padTop + innerH - ((value - lo) / span) * innerH;
  const secondary = dual ? columns[1].values : [];
  const hi2 = Math.max(1, ...secondary);
  const lo2 = Math.min(0, ...secondary);
  const y2 = (value: number) => padTop + innerH - ((value - lo2) / (hi2 - lo2 || 1)) * innerH;

  const count = Math.max(1, labels.length);
  const band = innerW / count;
  const x = (index: number) => padLeft + band * (index + 0.5);
  const selectedIndex = selection?.index ?? -1;
  const selectAt = (index: number, series: Array<{ name: string; values: number[]; color: string }>) => {
    toggleSelection({
      index,
      label: String(labels[index] ?? ''),
      entries: series.map((column) => ({ name: column.name, value: formatMetric(column.values[index] ?? 0), color: column.color })),
    });
  };
  const hitBands = (onPressAt: (index: number) => void) =>
    labels.map((_, index) => (
      <Rect
        key={`hit-${index}`}
        x={padLeft + index * band}
        y={padTop}
        width={band}
        height={innerH}
        fill={colors.text}
        fillOpacity={0.001}
        onPress={() => onPressAt(index)}
      />
    ));

  const grid = (
    <>
      {[0, 0.5, 1].map((ratio) => {
        const gy = padTop + innerH * ratio;
        return (
          <React.Fragment key={ratio}>
            <Line x1={padLeft} y1={gy} x2={W - padRight} y2={gy} stroke={colors.border} strokeWidth={1} />
            <SvgText x={padLeft - 4} y={gy + 3} fill={colors.muted} fontSize={7.5} textAnchor="end">{compactNumber(hi - span * ratio)}</SvgText>
          </React.Fragment>
        );
      })}
    </>
  );
  const axisLabels = labels.length ? (
    <>
      {labels.map((label, index) => {
        if (index % labelStep !== 0) return null;
        const labelX = x(index);
        const labelY = H - 4 - (rotateLabels ? Math.max(0, ...labelWidths) * sinAngle : 0);
        const room = rotateLabels ? (padBottom - 14) / sinAngle : band - 4;
        return (
          <SvgText
            key={`ax-${index}`}
            x={labelX}
            y={labelY}
            fill={colors.muted}
            fontSize={8}
            textAnchor={rotateLabels ? 'end' : 'middle'}
            transform={rotateLabels ? `rotate(-40 ${labelX} ${labelY})` : undefined}
          >
            {fitChartLabel(String(label), room)}
          </SvgText>
        );
      })}
    </>
  ) : null;

  let body: React.ReactNode = null;
  let legend: Array<{ label: string; value?: number; color: string }> = [];
  let caption = '';
  let empty = false;

  if (type === 'pie') {
    if (!history.length) {
      empty = true;
    } else {
      const total = history.reduce((sum, point) => sum + Math.max(0, Number(point.value) || 0), 0) || 1;
      const cx = W / 2;
      const cy = H / 2;
      const r = Math.min(W, H) / 2 - 12;
      let angle = -Math.PI / 2;
      body = history.map((point, index) => {
        const value = Math.max(0, Number(point.value) || 0);
        const slice = (value / total) * Math.PI * 2;
        const end = angle + slice;
        const large = slice > Math.PI ? 1 : 0;
        const x1 = cx + r * Math.cos(angle);
        const y1 = cy + r * Math.sin(angle);
        const x2 = cx + r * Math.cos(end);
        const y2 = cy + r * Math.sin(end);
        const path = `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
        const fill = palette[index % palette.length];
        const active = selection?.index === index;
        angle = end;
        return (
          <Path
            key={`${point.label}-${index}`}
            d={path}
            fill={fill}
            fillOpacity={selection && !active ? 0.45 : 1}
            stroke={active ? colors.text : colors.panel}
            strokeWidth={active ? 1.6 : 1}
            onPress={() => toggleSelection({
              index,
              label: String(point.label),
              entries: [
                { name: '值', value: formatMetric(Number(point.value) || 0), color: fill },
                { name: '占比', value: `${((value / total) * 100).toFixed(1)}%`, color: fill },
              ],
            })}
          />
        );
      });
      legend = history.slice(0, 8).map((point, index) => ({ label: String(point.label), value: Number(point.value) || 0, color: palette[index % palette.length] }));
    }
  } else if (type === 'heatmap') {
    if (!chart.heatmap || !chart.heatmap.values.length) {
      empty = true;
    } else {
      const { xLabels, yLabels, values, valueLabel } = chart.heatmap;
      const flat = values.flat().map((value) => Number(value) || 0);
      const heatMax = Math.max(1, ...flat);
      const heatMin = Math.min(0, ...flat);
      const cellW = (innerW - 2) / Math.max(1, xLabels.length);
      const cellH = innerH / Math.max(1, yLabels.length);
      body = values.slice(0, yLabels.length).map((row, rowIndex) =>
        row.slice(0, xLabels.length).map((value, columnIndex) => {
          const numeric = Number(value) || 0;
          const fill = heatTone((numeric - heatMin) / (heatMax - heatMin || 1));
          const label = `${yLabels[rowIndex] ?? ''} · ${xLabels[columnIndex] ?? ''}`;
          const active = selection?.label === label;
          return (
            <Rect
              key={`${columnIndex}-${rowIndex}`}
              x={padLeft + columnIndex * cellW}
              y={padTop + rowIndex * cellH}
              width={Math.max(1, cellW - 2)}
              height={Math.max(1, cellH - 2)}
              rx={2}
              fill={fill}
              stroke={active ? colors.text : 'transparent'}
              strokeWidth={active ? 1.4 : 0}
              onPress={() => toggleSelection({ label, entries: [{ name: valueLabel || '值', value: formatMetric(numeric), color: fill }] })}
            />
          );
        }),
      );
      const xTicks = Array.from(new Set([0, Math.floor(xLabels.length / 2), xLabels.length - 1]));
      body = (
        <>
          {body}
          {yLabels.slice(0, 8).map((label, rowIndex) => (
            <SvgText key={`yl-${rowIndex}`} x={padLeft - 4} y={padTop + rowIndex * cellH + cellH / 2 + 3} fill={colors.muted} fontSize={7.5} textAnchor="end">
              {String(label).slice(0, 4)}
            </SvgText>
          ))}
          {xTicks.map((columnIndex) => (
            <SvgText key={`xl-${columnIndex}`} x={padLeft + columnIndex * cellW + cellW / 2} y={H - 5} fill={colors.muted} fontSize={7.5} textAnchor="middle">
              {String(xLabels[columnIndex] ?? '').slice(0, 5)}
            </SvgText>
          ))}
        </>
      );
      caption = `${valueLabel || '值'}：${compactNumber(heatMin)} → ${compactNumber(heatMax)}`;
    }
  } else if (type === 'scatter') {
    const points = chart.scatter?.length
      ? chart.scatter
      : history.map((point, index) => {
          const numeric = Number(point.label);
          return { x: Number.isFinite(numeric) ? numeric : index + 1, y: Number(point.value) || 0, label: String(point.label) };
        });
    if (!points.length) {
      empty = true;
    } else {
      const xs = points.map((point) => Number(point.x) || 0);
      const ys = points.map((point) => Number(point.y) || 0);
      const xHi = Math.max(1, ...xs);
      const xLo = Math.min(0, ...xs);
      const yHi = Math.max(1, ...ys);
      const yLo = Math.min(0, ...ys);
      const px = (value: number) => padLeft + ((value - xLo) / (xHi - xLo || 1)) * innerW;
      const py = (value: number) => padTop + innerH - ((value - yLo) / (yHi - yLo || 1)) * innerH;
      const pointLabel = (point: { x: number; y: number; label?: string }) =>
        point.label && String(point.label).trim() ? String(point.label) : `(${Number(point.x) || 0}, ${Number(point.y) || 0})`;
      const selectPoint = (point: { x: number; y: number; label?: string }) =>
        toggleSelection({
          label: pointLabel(point),
          entries: [
            { name: chart.xLabel || 'x', value: formatMetric(Number(point.x) || 0), color: palette[0] },
            { name: chart.yLabel || 'y', value: formatMetric(Number(point.y) || 0), color: palette[0] },
          ],
        });
      body = (
        <>
          <Line x1={padLeft} y1={padTop + innerH} x2={W - padRight} y2={padTop + innerH} stroke={colors.borderStrong} strokeWidth={1} />
          <Line x1={padLeft} y1={padTop} x2={padLeft} y2={padTop + innerH} stroke={colors.borderStrong} strokeWidth={1} />
          {points.slice(0, 180).map((point, index) => {
            const active = selection?.label === pointLabel(point);
            return (
              <Circle
                key={`dot-${index}`}
                cx={px(Number(point.x) || 0)}
                cy={py(Number(point.y) || 0)}
                r={active ? 4.6 : 2.6}
                fill={palette[0]}
                fillOpacity={active ? 1 : 0.72}
                stroke={active ? colors.text : 'transparent'}
                strokeWidth={active ? 1.2 : 0}
              />
            );
          })}
          <SvgText x={padLeft - 4} y={padTop + 4} fill={colors.muted} fontSize={7.5} textAnchor="end">{compactNumber(yHi)}</SvgText>
          <SvgText x={padLeft - 4} y={padTop + innerH + 3} fill={colors.muted} fontSize={7.5} textAnchor="end">{compactNumber(yLo)}</SvgText>
          <SvgText x={W - padRight} y={H - 5} fill={colors.muted} fontSize={8} textAnchor="end">{chart.xLabel ?? 'x'}</SvgText>
          {points.slice(0, 180).map((point, index) => (
            <Circle
              key={`hit-${index}`}
              cx={px(Number(point.x) || 0)}
              cy={py(Number(point.y) || 0)}
              r={9}
              fill={colors.text}
              fillOpacity={0.001}
              onPress={() => selectPoint(point)}
            />
          ))}
        </>
      );
    }
  } else if (type === 'radar') {
    if (history.length < 3) {
      empty = true;
    } else {
      const cx = W / 2;
      const cy = H / 2;
      const r = Math.min(W, H) / 2 - 22;
      const angleAt = (index: number) => -Math.PI / 2 + (index / history.length) * Math.PI * 2;
      const vertexAt = (index: number, value: number) => {
        const radius = (Math.max(0, value) / hi) * r;
        const angle = angleAt(index);
        return { cx: cx + radius * Math.cos(angle), cy: cy + radius * Math.sin(angle) };
      };
      const primaryVertices = history.map((point, index) => vertexAt(index, Number(point.value) || 0));
      body = (
        <>
          {[0.33, 0.66, 1].map((ratio) => (
            <Circle key={ratio} cx={cx} cy={cy} r={r * ratio} fill="none" stroke={colors.border} strokeWidth={1} />
          ))}
          {columns.map((column) => (
            <Polyline
              key={column.name}
              points={column.values.map((value, index) => { const vertex = vertexAt(index, value); return `${vertex.cx},${vertex.cy}`; }).join(' ')}
              fill={column.color}
              fillOpacity={0.12}
              stroke={column.color}
              strokeWidth={2}
            />
          ))}
          {history.map((point, index) => {
            const angle = angleAt(index);
            const labelX = cx + (r + 12) * Math.cos(angle);
            const labelY = cy + (r + 12) * Math.sin(angle) + 3;
            const anchor = Math.cos(angle) > 0.25 ? 'start' : Math.cos(angle) < -0.25 ? 'end' : 'middle';
            return (
              <SvgText key={`rl-${index}`} x={labelX} y={labelY} fill={colors.muted} fontSize={7.5} textAnchor={anchor}>
                {String(point.label).slice(0, 5)}
              </SvgText>
            );
          })}
          {primaryVertices.map((vertex, index) => (
            <Circle
              key={`hit-${index}`}
              cx={vertex.cx}
              cy={vertex.cy}
              r={9}
              fill={colors.text}
              fillOpacity={0.001}
              onPress={() => selectAt(index, columns)}
            />
          ))}
          {selectedIndex >= 0 ? columns.map((column) => {
            if (selectedIndex >= column.values.length) return null;
            const vertex = vertexAt(selectedIndex, column.values[selectedIndex]);
            return <Circle key={`sel-${column.name}`} cx={vertex.cx} cy={vertex.cy} r={3.4} fill={column.color} stroke={colors.text} strokeWidth={1} />;
          }) : null}
        </>
      );
      legend = columns.length > 1
        ? columns.map((column) => ({ label: column.name, color: column.color }))
        : history.slice(0, 5).map((point, index) => ({ label: String(point.label), value: Number(point.value) || 0, color: palette[index % palette.length] }));
    }
  } else if (!history.length) {
    empty = true;
  } else if (type === 'line') {
    const lineFor = (values: number[], scale: (value: number) => number, color: string) => (
      <>
        <Polyline points={values.map((value, index) => `${x(index)},${scale(value)}`).join(' ')} fill="none" stroke={color} strokeWidth={2} />
        {values.length <= 12 ? values.map((value, index) => <Circle key={index} cx={x(index)} cy={scale(value)} r={2.2} fill={color} />) : null}
      </>
    );
    const anchor = primary.length ? { x: x(primary.length - 1), y: y(primary[primary.length - 1]) } : null;
    const forecastPath = forecast.map((point, index) => `${index === 0 && anchor ? `M ${anchor.x} ${anchor.y} L` : index === 0 ? 'M' : 'L'} ${x(primary.length + index)} ${y(Number(point.value) || 0)}`).join(' ');
    const bandPath = forecast.length
      ? [
          ...forecast.map((point, index) => `${index === 0 ? 'M' : 'L'} ${x(primary.length + index)} ${y(Number(point.upper) || 0)}`),
          ...[...forecast].reverse().map((point, index) => `L ${x(primary.length + forecast.length - 1 - index)} ${y(Number(point.lower) || 0)}`),
          'Z',
        ].join(' ')
      : '';
    body = (
      <>
        {grid}
        {selectedIndex >= 0 ? <Line x1={x(selectedIndex)} y1={padTop} x2={x(selectedIndex)} y2={padTop + innerH} stroke={colors.borderStrong} strokeWidth={1} /> : null}
        {columns.map((column, index) => <React.Fragment key={column.name}>{lineFor(column.values, dual && index === 1 ? y2 : y, column.color)}</React.Fragment>)}
        {bandPath ? <Path testID="m-chart-forecast-band" d={bandPath} fill={palette[1]} fillOpacity={0.13} /> : null}
        {forecastPath ? <Path testID="m-chart-forecast-line" d={forecastPath} fill="none" stroke={palette[1]} strokeWidth={2} strokeDasharray="4 3" /> : null}
        {selectedIndex >= 0 ? columns.map((column, columnIndex) => (
          selectedIndex < column.values.length ? (
            <Circle
              key={`sel-${column.name}`}
              cx={x(selectedIndex)}
              cy={(dual && columnIndex === 1 ? y2 : y)(column.values[selectedIndex])}
              r={3.8}
              fill={column.color}
              stroke={colors.panel}
              strokeWidth={1.5}
            />
          ) : null
        )) : null}
        {axisLabels}
        {hitBands((index) => {
          if (index < history.length) {
            selectAt(index, columns);
            return;
          }
          const point = forecast[index - history.length];
          toggleSelection({
            index,
            label: String(labels[index] ?? ''),
            entries: [
              { name: '预测', value: formatMetric(Number(point?.value) || 0), color: palette[1] },
              { name: '区间', value: `${formatMetric(Number(point?.lower) || 0)} ~ ${formatMetric(Number(point?.upper) || 0)}`, color: palette[1] },
            ],
          });
        })}
      </>
    );
    legend = columns.map((column) => ({ label: column.name, color: column.color }));
    if (forecast.length) legend = [...legend, { label: '预测', color: palette[1] }];
  } else if (dual) {
    const barW = Math.min(band * 0.5, 30);
    const path = secondary.map((value, index) => `${x(index)},${y2(value)}`).join(' ');
    body = (
      <>
        {grid}
        {selectedIndex >= 0 ? <Rect x={padLeft + selectedIndex * band} y={padTop} width={band} height={innerH} fill={palette[0]} fillOpacity={0.07} /> : null}
        {primary.map((value, index) => {
          const top = y(Math.max(value, 0));
          const bottom = y(Math.min(value, 0));
          return <Rect key={index} x={x(index) - barW / 2} y={top} width={barW} height={Math.max(1, bottom - top)} rx={2.5} fill={palette[0]} fillOpacity={0.9} />;
        })}
        <Polyline points={path} fill="none" stroke={palette[1]} strokeWidth={2} />
        {secondary.map((value, index) => <Circle key={index} cx={x(index)} cy={y2(value)} r={2.2} fill={palette[1]} />)}
        {axisLabels}
        {hitBands((index) => selectAt(index, columns))}
      </>
    );
    legend = [
      { label: columns[0].name, color: palette[0] },
      { label: `${columns[1].name}（右轴）`, color: palette[1] },
    ];
  } else if (stacked) {
    const barW = Math.min(band * 0.62, 34);
    body = (
      <>
        {grid}
        {selectedIndex >= 0 ? <Rect x={padLeft + selectedIndex * band} y={padTop} width={band} height={innerH} fill={palette[0]} fillOpacity={0.07} /> : null}
        {history.map((point, index) => {
          let positive = 0;
          let negative = 0;
          return (
            <React.Fragment key={`${point.label}-${index}`}>
              {columns.map((column) => {
                const value = column.values[index] ?? 0;
                const base = value >= 0 ? positive : negative;
                const end = base + value;
                if (value >= 0) positive = end;
                else negative = end;
                const top = y(Math.max(base, end));
                const bottom = y(Math.min(base, end));
                return <Rect key={column.name} x={x(index) - barW / 2} y={top} width={barW} height={Math.max(1, bottom - top)} rx={1.5} fill={column.color} fillOpacity={0.92} />;
              })}
            </React.Fragment>
          );
        })}
        {axisLabels}
        {hitBands((index) => selectAt(index, columns))}
      </>
    );
    legend = columns.map((column) => ({ label: column.name, color: column.color }));
  } else if (columns.length > 1) {
    const groupW = band * 0.78;
    const barW = groupW / columns.length;
    body = (
      <>
        {grid}
        {selectedIndex >= 0 ? <Rect x={padLeft + selectedIndex * band} y={padTop} width={band} height={innerH} fill={palette[0]} fillOpacity={0.07} /> : null}
        {history.map((point, index) => (
          <React.Fragment key={`${point.label}-${index}`}>
            {columns.map((column, columnIndex) => {
              const value = column.values[index] ?? 0;
              const top = y(Math.max(value, 0));
              const bottom = y(Math.min(value, 0));
              return (
                <Rect
                  key={column.name}
                  x={x(index) - groupW / 2 + columnIndex * barW}
                  y={top}
                  width={Math.max(1, barW - 2)}
                  height={Math.max(1, bottom - top)}
                  rx={2}
                  fill={column.color}
                  fillOpacity={0.92}
                />
              );
            })}
          </React.Fragment>
        ))}
        {axisLabels}
        {hitBands((index) => selectAt(index, columns))}
      </>
    );
    legend = columns.map((column) => ({ label: column.name, color: column.color }));
  } else {
    const barW = Math.min(band * 0.62, 34);
    body = (
      <>
        {grid}
        {selectedIndex >= 0 ? <Rect x={padLeft + selectedIndex * band} y={padTop} width={band} height={innerH} fill={palette[0]} fillOpacity={0.07} /> : null}
        {history.map((point, index) => {
          const value = Number(point.value) || 0;
          const top = y(Math.max(value, 0));
          const bottom = y(Math.min(value, 0));
          return <Rect key={`${point.label}-${index}`} x={x(index) - barW / 2} y={top} width={barW} height={Math.max(1, bottom - top)} rx={2.5} fill={palette[index % palette.length]} fillOpacity={0.92} />;
        })}
        {axisLabels}
        {hitBands((index) => selectAt(index, [{ ...columns[0], color: palette[index % palette.length] }]))}
      </>
    );
    legend = history.slice(0, 6).map((point, index) => ({ label: String(point.label), value: Number(point.value) || 0, color: palette[index % palette.length] }));
  }

  const axisHint = [chart.xLabel, chart.yLabel].filter(Boolean).join(' × ');
  const hasData = history.length > 0 || Boolean(chart.heatmap?.values.length) || Boolean(chart.scatter?.length);
  return (
    <View testID="m-agent-chart" style={{ marginTop: 7, gap: 5 }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
        <Text style={styles.chartTitle} numberOfLines={2}>{chart.title ?? '图表'}</Text>
        {axisHint ? <Text style={styles.chartAxisHint} numberOfLines={1}>{axisHint}</Text> : null}
      </View>
      {hasData && (allowTypeSwitch || canInsight) ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 3 }}>
          {allowTypeSwitch ? CHART_TYPES.map((item) => {
            const active = item.value === type;
            const blocked = !active && fit[item.value]?.ok === false;
            return (
              <Pressable
                key={item.value}
                testID={`m-chart-type-${item.value}`}
                disabled={blocked}
                accessibilityLabel={item.label}
                accessibilityState={{ selected: active, disabled: blocked }}
                style={[styles.chartTypeChip, active && styles.chartTypeChipActive, blocked && styles.chartTypeChipBlocked]}
                onPress={() => {
                  if (item.value !== 'line') setForecastOverlay(null);
                  setType(item.value);
                  setSelection(null);
                }}
              >
                <item.icon size={10} color={active ? colors.accent : blocked ? colors.muted : colors.secondary} />
                <Text style={[styles.chartTypeText, active && styles.chartTypeTextActive]}>{item.label}</Text>
              </Pressable>
            );
          }) : null}
          {canInsight ? (
            <>
              <Pressable
                testID="m-chart-analyze"
                disabled={insightBusy != null}
                accessibilityLabel={translate('解读')}
                accessibilityState={{ selected: Boolean(analysis), disabled: insightBusy != null }}
                style={[styles.chartTypeChip, analysis && styles.chartTypeChipActive, insightBusy != null && styles.chartTypeChipBlocked]}
                onPress={() => void runInsight('analyze')}
              >
                {insightBusy === 'analyze' ? <Loader2 size={10} color={colors.accent} /> : <Sparkles size={10} color={analysis ? colors.accent : colors.secondary} />}
                <Text style={[styles.chartTypeText, analysis && styles.chartTypeTextActive]}>{translate('解读')}</Text>
              </Pressable>
              <Pressable
                testID="m-chart-forecast"
                disabled={insightBusy != null}
                accessibilityLabel={translate('预测')}
                accessibilityState={{ selected: Boolean(forecastOverlay), disabled: insightBusy != null }}
                style={[styles.chartTypeChip, forecastOverlay && styles.chartTypeChipActive, insightBusy != null && styles.chartTypeChipBlocked]}
                onPress={() => void runInsight('forecast')}
              >
                {insightBusy === 'forecast' ? <Loader2 size={10} color={colors.accent} /> : <TrendingUp size={10} color={forecastOverlay ? colors.accent : colors.secondary} />}
                <Text style={[styles.chartTypeText, forecastOverlay && styles.chartTypeTextActive]}>{translate('预测')}</Text>
              </Pressable>
            </>
          ) : null}
        </ScrollView>
      ) : null}
      {empty ? (
        <View style={styles.chartEmpty}><Text style={styles.listMeta}>没有可绘制的数据点（结果集为空或全为 NULL）</Text></View>
      ) : (
        <View style={styles.chartCard}>
          <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`}>
            <Rect x={0} y={0} width={W} height={H} fill={colors.text} fillOpacity={0.001} onPress={() => setSelection(null)} />
            {body}
          </Svg>
          {selection ? (
            <View
              testID="m-chart-tooltip"
              pointerEvents="none"
              style={[styles.chartTooltip, selection.index !== undefined && selection.index < labels.length / 2 ? { right: 6 } : { left: 6 }]}
            >
              <Text style={styles.chartTooltipLabel} numberOfLines={1}>{selection.label}</Text>
              {selection.entries.map((entry, index) => (
                <View key={`${entry.name}-${index}`} style={styles.chartTooltipRow}>
                  <View style={[styles.chartTooltipDot, { backgroundColor: entry.color }]} />
                  <Text style={styles.chartTooltipName} numberOfLines={1}>{entry.name}</Text>
                  <Text style={styles.chartTooltipValue} numberOfLines={1}>{entry.value}</Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      )}
      {analysis ? (
        <View testID="m-chart-insight-strip" style={styles.chartInsightStrip}>
          {([
            { label: translate('合计'), value: formatMetric(analysis.sum) },
            { label: translate('均值'), value: formatMetric(analysis.avg) },
            { label: translate('最大'), value: formatMetric(analysis.max), hint: analysis.argmax },
            { label: translate('最小'), value: formatMetric(analysis.min), hint: analysis.argmin },
            ...analysis.topShare.slice(0, 3).map((item) => ({ label: item.label, value: `${(item.share * 100).toFixed(1)}%` })),
            ...(analysis.isTimeSeries ? analysis.deltas.slice(-3).map((item) => ({ label: item.label, value: `${item.delta >= 0 ? '+' : ''}${formatMetric(item.delta)}`, tone: item.delta >= 0 ? ('up' as const) : ('down' as const) })) : []),
          ] as Array<{ label: string; value: string; hint?: string; tone?: 'up' | 'down' }>).map((stat, index) => (
            <View key={`${stat.label}-${index}`} style={styles.chartInsightStat}>
              <Text style={styles.chartInsightLabel} numberOfLines={1}>{stat.label}{stat.hint ? ` · ${stat.hint}` : ''}</Text>
              <Text style={[styles.chartInsightValue, stat.tone === 'up' && { color: colors.success }, stat.tone === 'down' && { color: colors.danger }]} numberOfLines={1}>{stat.value}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {insightError ? <Text testID="m-chart-insight-error" style={styles.chartInsightError}>{insightError}</Text> : null}
      {caption ? <Text style={styles.chartNote}>{caption}</Text> : null}
      {legend.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {legend.map((item, index) => (
            <View key={`${item.label}-${index}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
              <View style={{ width: 7, height: 7, borderRadius: 2, backgroundColor: item.color }} />
              <Text style={styles.listMeta} numberOfLines={1}>{item.label}{item.value !== undefined ? ` · ${item.value.toLocaleString()}` : ''}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {chart.note ? <Text style={styles.chartNote}>{chart.note}</Text> : null}
    </View>
  );
}
