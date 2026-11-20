import React from 'react';
import { View } from 'react-native';
import { Sparkles } from 'lucide-react-native';
import type { AgentMessage } from '@aidb/core';
import { colors } from '../../theme';
import { styles } from '../../styles';
import { Text } from '../base';
import { Markdown } from '../markdown';
import { MobileChart } from '../chart/MobileChart';
import { chartOf, mobileTurnFromBlocks, type MobileTurnEntry } from './turnModel';
import { ExecutionSection, ThinkingBlock, MobileToolCard, PlanCard } from './cards';

/**
 * 连续的工具条目折成一段执行过程；正文、思考与图表摊在流里，位置保持真实顺序。
 * 同一个 step 的条目再套一层带左轨的容器（桌面端 .turn-step 同一套做法）：
 * 「这句解释对应哪条 SQL」只靠相邻关系看不出来，框在一起才看得出是同一轮。
 */
export function MobileTurnTimeline({ entries, running, inlineCharts = true }: { entries: MobileTurnEntry[]; running?: boolean; inlineCharts?: boolean }) {
  const stepNodes: React.ReactNode[] = [];
  let current: { key: string; step?: number; entries: MobileTurnEntry[] } | null = null;
  const pushStep = () => {
    if (!current || !current.entries.length) {
      current = null;
      return;
    }
    const node = current;
    current = null;
    // 只有带步号的才套左轨：旧数据排不出步，套上去只是多一层没意义的缩进，
    // 而且那条本来就被外层「执行过程」包着。
    stepNodes.push(
      node.step === undefined ? (
        <StepEntries key={node.key} entries={node.entries} running={running} inlineCharts={inlineCharts} />
      ) : (
        <View key={node.key} style={styles.turnStep}>
          <StepEntries entries={node.entries} running={running} inlineCharts={inlineCharts} />
        </View>
      ),
    );
  };
  entries.forEach((entry) => {
    if (entry.step !== undefined) {
      if (!current || current.step !== entry.step) {
        pushStep();
        current = { key: `step_${entry.step}_${stepNodes.length}`, step: entry.step, entries: [] };
      }
      current.entries.push(entry);
      return;
    }
    if (entry.kind === 'tool' || entry.kind === 'chart') {
      // 工具属于上面那一步：它是那一步的模型调用发出来的。并进去，
      // 「我先按 status 分组」和它那条 SQL 才在同一个框里。
      if (current && current.step !== undefined) current.entries.push(entry);
      else {
        current = { key: `tools_${stepNodes.length}`, entries: [entry] };
        pushStep();
      }
      return;
    }
    // 正在生成的半截正文/思考（没有 step）自己占一段：跟在上一步后面会被读成那一步讲完了
    pushStep();
    stepNodes.push(<StepEntries key={`live_${stepNodes.length}`} entries={[entry]} running={running} inlineCharts={inlineCharts} />);
  });
  pushStep();
  return <>{stepNodes}</>;
}

function StepEntries({ entries, running, inlineCharts = true }: { entries: MobileTurnEntry[]; running?: boolean; inlineCharts?: boolean }) {
  const nodes: React.ReactNode[] = [];
  let pending: MobileTurnEntry[] = [];
  const flush = () => {
    if (!pending.length) return;
    nodes.push(
      <ExecutionSection key={`tools_${nodes.length}`} count={pending.length} running={running}>
        {pending.map((entry) => (
          <MobileToolCard
            key={entry.call!.callId}
            tool={entry.call!.tool}
            args={entry.call!.args}
            risk={entry.call!.risk}
            status={entry.call!.status}
            result={entry.call!.result}
            summary={entry.call!.summary}
          />
        ))}
      </ExecutionSection>,
    );
    pending = [];
  };
  entries.forEach((entry) => {
    if (entry.kind === 'tool') {
      pending.push(entry);
      return;
    }
    flush();
    if (entry.kind === 'chart') {
      // 旧数据（没有步号）把图表统一挪到正文末尾；只有带步的时间线才就地渲染
      if (inlineCharts) {
        const chart = chartOf(entry.call!.result);
        if (chart) nodes.push(<MobileChart key={entry.key} chart={chart} />);
      }
      return;
    }
    nodes.push(
      entry.kind === 'text' ? (
        <Markdown key={entry.key} text={entry.text ?? ''} />
      ) : (
        <ThinkingBlock key={entry.key} text={entry.text ?? ''} />
      ),
    );
  });
  flush();
  return <>{nodes}</>;
}

export function AssistantMessage({ message }: { message: AgentMessage }) {
  const turn = mobileTurnFromBlocks(message.blocks);
  const tools = turn.toolCount;
  const cardTools = turn.entries.filter((entry) => entry.kind === 'tool').length;
  // 模型每更新一次计划都会追加一个 plan block；只渲染最后一份，避免旧计划卡堆叠。
  const latestPlan = [...message.blocks].reverse().find((block) => block.type === 'plan');
  const hasExecution = Boolean(turn.legacyThinking) || cardTools > 0 || Boolean(latestPlan);
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', gap: 7, alignItems: 'center' }}>
        <View style={styles.agentAvatar}><Sparkles size={10} color={colors.agent} /></View>
        <Text style={styles.listMeta}>AiDB Agent</Text>
      </View>
      <View style={{ paddingLeft: 26, gap: 10 }}>
        {/* 分段消息不再另渲染 content：message.content 就是各步正文拼起来的那一份，
            时间线里已经按顺序说过一遍。旧数据没有分段块，才用它兜底。 */}
        {turn.stepped ? <MobileTurnTimeline entries={turn.entries} /> : null}
        {turn.stepped ? null : hasExecution ? (
          <ExecutionSection count={cardTools} running={false}>
            {turn.legacyThinking ? <ThinkingBlock text={turn.legacyThinking} /> : null}
            <MobileTurnTimeline entries={turn.entries} inlineCharts={false} />
            {latestPlan ? <PlanCard items={latestPlan.items ?? []} /> : null}
          </ExecutionSection>
        ) : null}
        {turn.stepped ? null : message.content ? <Markdown text={message.content} /> : null}
        {turn.stepped ? null : turn.entries
          .filter((entry) => entry.kind === 'chart')
          .map((entry) => <MobileChart key={`${message.id}_chart_${entry.call!.callId}`} chart={chartOf(entry.call!.result)!} />)}
        {tools ? <Text style={styles.turnEnd}>{tools} 次工具调用</Text> : null}
      </View>
    </View>
  );
}
