import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, View, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollViewInstance } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowDown, AtSign, Brain, Check, ChevronDown, Database, History, ImagePlus, Loader2, MessageSquarePlus, RefreshCw, Send, Sparkles, Square, TerminalSquare, X } from 'lucide-react-native';
import { normalizeSuggestionPrompt, suggestionLabel, type AgentSettings, type AgentMessage, type AgentSessionMeta, type QuestionSuggestion, type ConnectionConfig, type PermissionMode, type TableInfo } from '@aidb/core';
import { colors, modeLabels } from '../theme';
import { currentLocale, translate } from '../i18n';
import { styles } from '../styles';
import { timeAgo } from '../lib/utils';
import type { LiveTurn } from '../types';
import { Text, TextInput, EngineLogo } from '../components/base';
import { PermissionSelect } from '../components/PermissionSelect';
import { Markdown } from '../components/markdown';
import { ChartInsightContext } from '../components/chart/ChartInsightContext';
import { MobileChart } from '../components/chart/MobileChart';
import { chartOf, isUnfinishedLiveTurn, liveTurnEndLabel, mobileTurnFromLive } from '../components/chat/turnModel';
import { UserBubble, ThinkingBlock, ExecutionSection, MobileToolCard, PlanCard } from '../components/chat/cards';
import { AssistantMessage, MobileTurnTimeline } from '../components/chat/AssistantMessage';
import type { BridgeClient } from '../bridge';

export function ChatScreen({
  client,
  sessionMeta,
  connection,
  sessions,
  messages,
  live,
  input,
  setInput,
  mode,
  setMode,
  busy,
  sending,
  scopeLocked,
  connected,
  onSend,
  onStop,
  onCancelSend,
  onNew,
  onOpenSessions,
  onOpenConnections,
  onOpenTables,
  onOpenCommands,
  onOpenRecent,
  scrollRef,
  onScroll,
  onContentSizeChange,
  showJump,
  onJumpToLatest,
  tables,
  agentSettings,
  onSaveAgent,
  canManageHost,
  databases,
  database,
  onOpenDatabases,
  pendingImages,
  uploadingImage,
  onPickImage,
  onRemoveImage,
}: {
  client: BridgeClient;
  sessionMeta?: AgentSessionMeta;
  connection?: ConnectionConfig;
  connections: ConnectionConfig[];
  sessions: AgentSessionMeta[];
  messages: AgentMessage[];
  live?: LiveTurn;
  input: string;
  setInput: (text: string) => void;
  mode: PermissionMode;
  setMode: (mode: PermissionMode) => void;
  busy: boolean;
  sending: boolean;
  scopeLocked: boolean;
  connected: boolean;
  onSend: () => void;
  onStop: () => void;
  onCancelSend: () => void;
  onNew: () => void;
  onOpenSessions: () => void;
  onOpenConnections: () => void;
  onOpenTables: () => void;
  onOpenCommands: () => void;
  onOpenRecent: (id: string) => void;
  scrollRef: React.RefObject<ScrollViewInstance | null>;
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onContentSizeChange: () => void;
  showJump: boolean;
  onJumpToLatest: () => void;
  tables: TableInfo[];
  agentSettings?: AgentSettings;
  onSaveAgent: (patch: Record<string, unknown>) => void;
  canManageHost: boolean;
  databases: string[];
  database?: string;
  onOpenDatabases: () => void;
  pendingImages: Array<{ id: string; mime: string }>;
  uploadingImage: boolean;
  onPickImage: () => void;
  onRemoveImage: (id: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const [modelSheet, setModelSheet] = useState(false);
  // 猜你想问与桌面同源：结构推荐 + 最近真实问过的问题（recent 带「问过」徽标）
  const suggestCtx = React.useContext(ChartInsightContext);
  const [suggestions, setSuggestions] = useState<QuestionSuggestion[]>([]);
  const [suggestBusy, setSuggestBusy] = useState(false);
  // 换一换的排除集：本视图展示过的 prompt 累积在这里，连接/库/会话变化时清空重来。
  const shownSuggestRef = React.useRef<Set<string>>(new Set());
  useEffect(() => {
    shownSuggestRef.current = new Set();
    const client = suggestCtx?.client;
    const connectionId = suggestCtx?.connectionId;
    if (!client || !connectionId) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    client
      .suggest({ connectionId, database: suggestCtx?.database, limit: 4, locale: currentLocale(), sessionId: sessionMeta?.id })
      .then((res) => {
        if (!cancelled) {
          setSuggestions(res.suggestions);
          for (const s of res.suggestions) shownSuggestRef.current.add(normalizeSuggestionPrompt(s.prompt));
        }
      })
      .catch(() => {
        if (!cancelled) setSuggestions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [suggestCtx?.client, suggestCtx?.connectionId, suggestCtx?.database, sessionMeta?.id, tables.length]);

  // 换一换：与桌面同一套排除/回绕协议；刷新失败或无候选时保持原有推荐。
  const refreshSuggestions = async () => {
    const client = suggestCtx?.client;
    const connectionId = suggestCtx?.connectionId;
    if (!client || !connectionId || suggestBusy) return;
    setSuggestBusy(true);
    try {
      const res = await client.suggest({ connectionId, database: suggestCtx?.database, limit: 4, locale: currentLocale(), sessionId: sessionMeta?.id, exclude: [...shownSuggestRef.current] });
      if (res.suggestions.length) {
        const keys = res.suggestions.map((s) => normalizeSuggestionPrompt(s.prompt));
        if (keys.every((k) => shownSuggestRef.current.has(k))) shownSuggestRef.current = new Set();
        for (const k of keys) shownSuggestRef.current.add(k);
        setSuggestions(res.suggestions);
      }
    } catch {
      /* 刷新失败保持原有推荐，不打断用户 */
    } finally {
      setSuggestBusy(false);
    }
  };
  const modelOptions = useMemo(() => {
    const configs = agentSettings?.modelConfigs ?? [];
    const base = configs.flatMap((config) =>
      config.models.map((entry) => ({
        configId: config.id,
        model: entry.id,
        label: entry.name || entry.id,
        provider: config.name || config.baseUrl || config.id,
      })),
    );
    if (!base.length && agentSettings?.model) {
      base.push({ configId: agentSettings.activeModelId ?? 'default', model: agentSettings.model, label: agentSettings.model, provider: agentSettings.provider });
    }
    const counts = new Map<string, number>();
    for (const item of base) counts.set(item.label, (counts.get(item.label) ?? 0) + 1);
    return base.map((item) => (counts.get(item.label)! > 1 ? { ...item, label: `${item.label} · ${item.provider}` } : item));
  }, [agentSettings]);
  const activeModelIndex = modelOptions.findIndex(
    (item) => item.configId === (agentSettings?.activeModelId ?? agentSettings?.modelConfigs?.[0]?.id) && item.model === agentSettings?.model,
  );
  const profile = agentSettings?.model ? agentSettings.modelProfiles?.[agentSettings.model] : undefined;
  const tierLevels = profile?.reasoning
    ? [...new Set((profile.reasoningTiers ?? []).filter((tier) => tier.value?.trim()).map((tier) => tier.level))]
    : [];
  const modelLabel = modelOptions[activeModelIndex]?.label ?? agentSettings?.model ?? '未配置模型';
  const tierLabel = agentSettings?.reasoningTier ?? 'Default';
  const switchModel = (item: { configId: string; model: string }) => {
    if (!agentSettings) return;
    const tiers = agentSettings.modelProfiles?.[item.model]?.reasoningTiers ?? [];
    const keep = agentSettings.reasoningTier && tiers.some((tier) => tier.level === agentSettings.reasoningTier);
    onSaveAgent({ activeModelId: item.configId, model: item.model, ...(keep ? {} : { reasoningTier: null }) });
    setModelSheet(false);
  };
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.chatHead}>
        <View style={{ flex: 1 }}>
          <Text style={styles.chatTitle} numberOfLines={1}>{sessionMeta?.title ?? 'AI 助手'}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 1 }}>
            <Pressable testID="m-connection" style={styles.connInline} onPress={onOpenConnections} disabled={scopeLocked}>
              <EngineLogo engine={connection?.engine} size={14} />
              <Text style={styles.listMeta} numberOfLines={1}>{connection?.name ?? '未选择连接'}</Text>
              <ChevronDown size={11} color={colors.muted} />
            </Pressable>
            {databases.length > 1 ? (
              <Pressable testID="m-database" style={styles.connInline} onPress={onOpenDatabases} disabled={scopeLocked}>
                <Database size={10} color={colors.accent} />
                <Text style={styles.listMeta} numberOfLines={1}>{database ?? '选择库'}</Text>
                <ChevronDown size={10} color={colors.muted} />
              </Pressable>
            ) : null}
          </View>
        </View>
        <Pressable testID="m-sessions" style={styles.iconButton} onPress={onOpenSessions}>
          <History size={16} color={colors.text} />
        </Pressable>
        <Pressable testID="m-new-session" style={styles.iconButton} onPress={onNew} disabled={scopeLocked}>
          <MessageSquarePlus size={16} color={colors.text} />
        </Pressable>
      </View>

      <View style={{ flex: 1 }}>
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 14, paddingBottom: 24, gap: 14 }}
          keyboardShouldPersistTaps="handled"
          onScroll={onScroll}
          scrollEventThrottle={16}
          onContentSizeChange={onContentSizeChange}
        >
        {!messages.length && !live ? (
          <View style={styles.chatEmpty}>
            <View style={styles.agentAvatarLarge}><Sparkles size={22} color={colors.agent} /></View>
            <Text style={styles.emptyTitle}>AI 数据库搭档</Text>
            <Text style={styles.emptyHint}>用自然语言查询、建表、排查。工具调用、审批与记忆在桌面与移动端同步。</Text>
            {suggestions.length ? (
              <View style={styles.suggestList}>
                <View style={styles.suggestHead}>
                  <Text style={styles.sectionLabel}>猜你想问</Text>
                  <Pressable testID="m-suggest-refresh" accessibilityLabel={translate('换一换')} onPress={() => void refreshSuggestions()} disabled={suggestBusy} style={styles.suggestRefresh}>
                    {suggestBusy ? <Loader2 size={12} color={colors.agent} /> : <RefreshCw size={12} color={colors.secondary} />}
                  </Pressable>
                </View>
                {suggestions.map((s) => {
                  const label = suggestionLabel(s.kind, /^zh/i.test(currentLocale()) ? 'zh' : 'en');
                  return (
                    <Pressable key={s.id} testID={`m-suggest-${s.kind}`} style={styles.capItem} onPress={() => setInput(s.prompt)}>
                      {s.kind === 'recent' ? <History size={12} color={colors.agent} /> : <Sparkles size={12} color={colors.agent} />}
                      <Text style={[styles.capText, { flex: 1 }]} numberOfLines={1}>{s.prompt}</Text>
                      <Text style={styles.suggestBadge}>{label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : null}
            <View style={styles.capList}>
              {[
                '给数据库做一次体检',
                tables.find((t) => t.name === 'orders') ? '按 status 统计 orders 并画柱状图' : '按分组统计并画柱状图',
                tables.find((t) => t.name === 'orders') ? '检查 orders 的空值、重复主键' : '检查当前表的空值、重复主键',
                '备份当前数据库',
              ].map((prompt) => (
                <Pressable key={prompt} style={styles.capItem} onPress={() => setInput(prompt)}>
                  <TerminalSquare size={12} color={colors.agent} />
                  <Text style={styles.capText}>{prompt}</Text>
                </Pressable>
              ))}
            </View>
            {sessions.length ? (
              <View style={{ width: '100%', marginTop: 16 }}>
                <Text style={styles.sectionLabel}>最近会话</Text>
                {sessions.slice(0, 3).map((session) => (
                  <Pressable key={session.id} style={styles.recentRow} onPress={() => onOpenRecent(session.id)}>
                    <TerminalSquare size={12} color={colors.agent} />
                    <Text style={styles.recentText} numberOfLines={1}>{session.title}</Text>
                    <Text style={styles.listMeta}>{timeAgo(session.updatedAt)}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>
        ) : null}

        {messages.map((message) =>
          message.role === 'user' ? (
            <UserBubble key={message.id} client={client} text={message.content} images={message.blocks.flatMap((block) => block.type === 'image' && block.attachmentId ? [block.attachmentId] : [])} />
          ) : (
            <AssistantMessage key={message.id} message={message} />
          ),
        )}

        {live ? (
          <>
            <UserBubble client={client} text={live.userText} images={live.userImages} />
            <View style={{ gap: 10 }}>
              {live.memories.length ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5 }}>
                  {live.memories.map((memory) => (
                    <View key={memory.id} style={styles.memoryPill}>
                      <Brain size={9} color={colors.muted} />
                      <Text style={styles.memoryPillText} numberOfLines={1}>{memory.title}</Text>
                    </View>
                  ))}
                </View>
              ) : null}
              {(() => {
                const turn = mobileTurnFromLive(live);
                if (turn.stepped) {
                  // 计划卡不折：它要一直看得见，不该跟着步骤滚走
                  return (
                    <>
                      {live.plan.length ? <PlanCard items={live.plan} /> : null}
                      <MobileTurnTimeline entries={turn.entries} running={busy} />
                    </>
                  );
                }
                const cardTools = turn.entries.filter((entry) => entry.kind === 'tool').length;
                return (
                  <>
                    {live.thinking || cardTools || live.plan.length ? (
                      <ExecutionSection count={cardTools} running={busy}>
                        {live.thinking ? <ThinkingBlock text={live.thinking} /> : null}
                        {live.tools.map((tool) => (
                          <MobileToolCard key={tool.callId} tool={tool.tool} args={tool.args} risk={tool.risk} status={tool.status} result={tool.result} summary={tool.summary} showChart={!chartOf(tool.result)} />
                        ))}
                        {live.plan.length ? <PlanCard items={live.plan} /> : null}
                      </ExecutionSection>
                    ) : null}
                    {live.text ? <Markdown text={live.text} /> : null}
                    {live.tools.filter((tool) => chartOf(tool.result)).map((tool) => (
                      <MobileChart key={`chart_${tool.callId}`} chart={chartOf(tool.result)!} />
                    ))}
                  </>
                );
              })()}
              {busy && !live.stream ? (
                <View style={styles.loadingRow}>
                  <Loader2 size={12} color={colors.agent} />
                  <Text style={styles.listMeta}>{live.status === 'awaiting' ? '等待授权…' : '正在处理…'}</Text>
                </View>
              ) : null}
              {live.error ? <Text style={styles.error}>{live.error}</Text> : null}
              {!busy && !live.error && isUnfinishedLiveTurn(live) ? (
                <Text style={[styles.hint, { color: colors.warning }]}>
                  {live.status === 'aborted' && live.abortCause === 'stalled'
                    ? live.abortReason ?? '模型连接无响应，本回合已停止。'
                    : live.status === 'aborted' && live.abortCause === 'deadline'
                      ? live.abortReason ?? '回合已到达绝对时间预算，尚未完成。'
                      : live.stop === 'max_steps'
                      ? '已达到本次工具步数上限，剩下的步骤还没做。'
                      : live.stop === 'max_output_tokens'
                        ? '模型输出被截断，本回合尚未完成。'
                        : '模型这一轮没有返回完整内容。'}
                </Text>
              ) : null}
              {!busy ? (
                <Text style={styles.turnEnd}>
                  {live.status === 'aborted' && live.abortCause !== 'stalled' ? live.abortReason ?? liveTurnEndLabel(live) : liveTurnEndLabel(live)} · {live.tools.length} 次工具 · {Math.max(1, Math.round(((live.endedAt ?? Date.now()) - live.startedAt) / 1000))}s
                  {live.tokensIn || live.tokensOut ? ` · ↑${live.tokensIn} ↓${live.tokensOut}` : ''}
                </Text>
              ) : null}
              {!busy && live.suggestions.length ? (
                <View style={styles.suggestList}>
                  <Text style={styles.sectionLabel}>继续问：</Text>
                  {live.suggestions.map((suggestion) => (
                    <Pressable key={suggestion.id} style={styles.capItem} onPress={() => setInput(suggestion.prompt)}>
                      <Sparkles size={12} color={colors.agent} />
                      <Text style={[styles.capText, { flex: 1 }]} numberOfLines={1}>{suggestion.prompt}</Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
            </View>
          </>
        ) : null}
        </ScrollView>
        {showJump ? (
          <View pointerEvents="box-none" style={styles.jumpWrap}>
            <Pressable testID="m-scroll-bottom" style={styles.jumpButton} onPress={onJumpToLatest}>
              <ArrowDown size={12} color={colors.secondary} />
              <Text style={styles.jumpText}>回到底部</Text>
            </Pressable>
          </View>
        ) : null}
      </View>

      <View style={styles.composer}>
        <View style={styles.composerTop}>
          {canManageHost ? (
            <Pressable testID="m-model-select" style={styles.modelPill} onPress={() => setModelSheet(true)}>
              <Sparkles size={10} color={colors.agent} />
              <Text style={styles.modelPillText} numberOfLines={1}>{modelLabel} · {tierLabel}</Text>
              <ChevronDown size={10} color={colors.muted} />
            </Pressable>
          ) : (
            <View testID="m-model-readonly" style={styles.modelPill}>
              <Sparkles size={10} color={colors.agent} />
              <Text style={styles.modelPillText} numberOfLines={1}>{modelLabel}</Text>
            </View>
          )}
          <PermissionSelect mode={mode} onChange={setMode} modes={canManageHost ? undefined : ['readonly', 'ask']} />
          <View style={styles.modeHint}>
            <Text style={styles.listMeta}>{connected ? 'Bridge 在线' : '重连中…'}</Text>
          </View>
        </View>
        {pendingImages.length ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingBottom: 6 }}>
            {pendingImages.map((image) => (
              <Pressable key={image.id} style={styles.modeChip} onPress={() => onRemoveImage(image.id)}>
                <ImagePlus size={11} color={colors.accent} />
                <Text style={styles.modeChipText}>图片 · 移除</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <View style={styles.inputBox}>
          <TextInput
            testID="m-chat-input"
            style={styles.chatInput}
            value={input}
            onChangeText={setInput}
            placeholder="描述目标，或输入 SQL…"
            placeholderTextColor={colors.muted}
            multiline
            maxLength={6000}
          />
          <View style={styles.inputToolbar}>
            <Pressable style={styles.inputTool} onPress={onOpenCommands} testID="m-commands">
              <TerminalSquare size={15} color={colors.accent} />
            </Pressable>
            <Pressable style={styles.inputTool} onPress={onOpenTables}>
              <AtSign size={15} color={colors.muted} />
            </Pressable>
            <Pressable style={styles.inputTool} onPress={onPickImage} disabled={uploadingImage || pendingImages.length >= 4} testID="m-image">
              {uploadingImage ? <ActivityIndicator size="small" color={colors.accent} /> : <ImagePlus size={15} color={colors.muted} />}
            </Pressable>
            <View style={{ flex: 1 }} />
            {busy || sending ? (
              <Pressable testID={sending ? 'm-cancel-send' : 'm-stop'} accessibilityLabel={sending ? '取消发送' : '停止'} style={[styles.sendButton, { backgroundColor: colors.danger }]} onPress={sending ? onCancelSend : onStop}>
                <Square size={13} color={colors.onSolid} />
              </Pressable>
            ) : (
              <Pressable testID="m-send" style={[styles.sendButton, (!input.trim() || !connected || uploadingImage || sending) && { opacity: 0.4 }]} onPress={onSend} disabled={!input.trim() || !connected || uploadingImage || sending}>
                <Send size={14} color={colors.onSolid} />
              </Pressable>
            )}
          </View>
        </View>
        <Text style={styles.composerHint}>{translate(modeLabels[mode])}{translate('模式 · @ 引用表 · 图片随消息发送')}</Text>
      </View>
      <Modal visible={canManageHost && modelSheet} transparent animationType="slide" onRequestClose={() => setModelSheet(false)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 14, maxHeight: '80%' }]}>
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle}>模型与思考程度</Text>
              <Pressable style={styles.iconButton} onPress={() => setModelSheet(false)}>
                <X size={16} color={colors.text} />
              </Pressable>
            </View>
            <ScrollView>
              <Text style={styles.sectionLabel}>模型</Text>
              {modelOptions.map((item) => {
                const active = activeModelIndex >= 0 && modelOptions[activeModelIndex]?.configId === item.configId && modelOptions[activeModelIndex]?.model === item.model;
                return (
                  <Pressable key={`${item.configId}:${item.model}`} style={[styles.sessionRow, active && { backgroundColor: colors.accentSoft }]} onPress={() => switchModel(item)}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.listTitle} numberOfLines={1}>{item.label}</Text>
                      <Text style={styles.listMeta}>{item.provider}</Text>
                    </View>
                    {active ? <Check size={14} color={colors.success} /> : null}
                  </Pressable>
                );
              })}
              {!modelOptions.length ? <Text style={[styles.hint, { padding: 14 }]}>桌面端「设置 → 模型」中添加模型后可在此切换。</Text> : null}
              {tierLevels.length ? (
                <>
                  <Text style={styles.sectionLabel}>思考程度</Text>
                  <Pressable
                    style={[styles.sessionRow, !agentSettings?.reasoningTier && { backgroundColor: colors.accentSoft }]}
                    onPress={() => {
                      onSaveAgent({ reasoningTier: null });
                      setModelSheet(false);
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.listTitle}>Default</Text>
                      <Text style={styles.listMeta}>不下发推理参数，使用服务商默认档位</Text>
                    </View>
                    {!agentSettings?.reasoningTier ? <Check size={14} color={colors.success} /> : null}
                  </Pressable>
                  {tierLevels.map((level) => (
                    <Pressable
                      key={level}
                      style={[styles.sessionRow, agentSettings?.reasoningTier === level && { backgroundColor: colors.accentSoft }]}
                      onPress={() => {
                        onSaveAgent({ reasoningTier: level });
                        setModelSheet(false);
                      }}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={styles.listTitle}>{level}</Text>
                        <Text style={styles.listMeta}>推理档位：{level}</Text>
                      </View>
                      {agentSettings?.reasoningTier === level ? <Check size={14} color={colors.success} /> : null}
                    </Pressable>
                  ))}
                </>
              ) : null}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

