import { useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

import * as ImagePicker from 'expo-image-picker';

import type { PermissionMode, TableInfo } from '@aidb/core';
import { BridgeClient, clearBridgeConfig, type BridgeConfig, type DataPage } from './src/bridge';
import { colors, type ThemeResolved } from './src/theme';
import type { Locale } from './src/i18n';
import { styles } from './src/styles';
import { notify } from './src/lib/utils';
import type { AgentTurnRef, TabKey, LiveTurn, ApprovalState } from './src/types';
import { BrandMark } from './src/components/base';

import { BottomTabs } from './src/components/BottomTabs';
import { TopBar } from './src/components/TopBar';
import { LoadingSplash, ErrorSplash } from './src/components/Splash';
import { ToolsRouter } from './src/components/ToolsRouter';

import { ChartInsightContext } from './src/components/chart/ChartInsightContext';

import { CommandScreen } from './src/screens/CommandScreen';
import { TableDataScreen } from './src/screens/TableDataScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';

import { MeScreen } from './src/screens/MeScreen';
import { PairScreen } from './src/screens/PairScreen';
import { ChatScreen } from './src/screens/ChatScreen';
import { CommandsSheet } from './src/components/sheets/CommandsSheet';
import { DataScreen } from './src/screens/DataScreen';
import { ConnectionsScreen } from './src/screens/ConnectionsScreen';
import { MemoryScreen } from './src/screens/MemoryScreen';
import { MemoryDraftSheet } from './src/components/sheets/MemoryDraftSheet';
import { DatabasesSheet } from './src/components/sheets/DatabasesSheet';
import { SessionsSheet } from './src/components/sheets/SessionsSheet';
import { RenameSessionSheet } from './src/components/sheets/RenameSessionSheet';
import { ConnectionsSheet } from './src/components/sheets/ConnectionsSheet';
import { TablesSheet } from './src/components/sheets/TablesSheet';
import { ApprovalSheet } from './src/components/sheets/ApprovalSheet';

import { useThemeLocale } from './src/hooks/useThemeLocale';
import { useBridgeConfig } from './src/hooks/useBridgeConfig';
import { useSchema } from './src/hooks/useSchema';
import { useSessions } from './src/hooks/useSessions';
import { useBootstrap } from './src/hooks/useBootstrap';
import { useAgentSocket } from './src/hooks/useAgentSocket';
import { useChatScroll } from './src/hooks/useChatScroll';
import { useMemories } from './src/hooks/useMemories';

export default function App() {
  const { themeMode, setThemeMode, resolvedTheme, locale, setLocale: setLocaleState } = useThemeLocale();
  return (
    <SafeAreaProvider>
      <StatusBar style={resolvedTheme === 'light' ? 'dark' : 'light'} />
      <Root themeMode={themeMode} resolvedTheme={resolvedTheme} onThemeMode={setThemeMode} locale={locale} onLocale={setLocaleState} />
    </SafeAreaProvider>
  );
}

function Root({ themeMode, resolvedTheme, onThemeMode, locale, onLocale }: { themeMode: 'dark' | 'light' | 'system'; resolvedTheme: ThemeResolved; onThemeMode: (mode: 'dark' | 'light' | 'system') => void; locale: Locale; onLocale: (locale: Locale) => void }) {
  const { config, setConfig, ready } = useBridgeConfig();

  if (!ready) {
    return (
      <View style={styles.splash}>
        <BrandMark size={48} />
        <ActivityIndicator color={colors.accent} style={{ marginTop: 16 }} />
      </View>
    );
  }

  if (!config) return <PairScreen onConnected={(cfg) => setConfig(cfg)} />;
  return (
    <Main
      config={config}
      themeMode={themeMode}
      resolvedTheme={resolvedTheme}
      onThemeMode={onThemeMode}
      locale={locale}
      onLocale={onLocale}
      onDisconnect={async () => {
        await clearBridgeConfig();
        setConfig(null);
      }}
    />
  );
}

function Main({ config, onDisconnect, themeMode, resolvedTheme, onThemeMode, locale, onLocale }: { config: BridgeConfig; onDisconnect: () => void; themeMode: 'dark' | 'light' | 'system'; resolvedTheme: ThemeResolved; onThemeMode: (mode: 'dark' | 'light' | 'system') => void; locale: Locale; onLocale: (locale: Locale) => void }) {
  const insets = useSafeAreaInsets();
  const client = useMemo(() => new BridgeClient(config), [config]);
  const [tab, setTab] = useState<TabKey>('chat');
  const [live, setLive] = useState<LiveTurn | undefined>();
  const turnRef = useRef<AgentTurnRef['current']>(undefined);
  const [approvalQueue, setApprovalQueue] = useState<ApprovalState[]>([]);
  const approval = approvalQueue[0];
  const [mode, setMode] = useState<PermissionMode>('readonly');
  const [input, setInput] = useState('');
  const [pendingImages, setPendingImages] = useState<Array<{ id: string; mime: string }>>([]);
  const [uploadingImage, setUploadingImage] = useState(false);
  const uploadingImageRef = useRef(false);
  const pickingImageRef = useRef(false);
  const [picker, setPicker] = useState<'sessions' | 'databases' | 'connections' | 'tables' | null>(null);
  const [selectedTable, setSelectedTable] = useState<TableInfo | null>(null);
  const [dataPage, setDataPage] = useState<DataPage | null>(null);
  const tableRequestRef = useRef(0);
  const [dataLoading, setDataLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [toolPage, setToolPage] = useState<'query' | 'table' | 'io' | 'backups' | 'dashboards' | 'pipelines' | 'dictionary' | 'monitor' | 'search' | 'history' | 'audit' | 'artifacts' | 'users' | null>(null);
  const [chatPage, setChatPage] = useState<'commands' | null>(null);
  const [mePage, setMePage] = useState<'memory' | 'connections' | 'settings' | null>(null);
  const [toolTable, setToolTable] = useState<string | undefined>(undefined);
  const [toolSql, setToolSql] = useState<string | undefined>(undefined);

  const busy = live?.status === 'streaming' || live?.status === 'awaiting';

  const scopeLockedRef = useRef(false);
  const sessionMutationLockedRef = useRef(false);
  const schema = useSchema(client, { setPicker, setSelectedTable, setDataPage, scopeLockedRef, sessionMutationLockedRef });
  const { connections, setConnections, activeConnectionId, setActiveConnectionId, databases, activeDatabase, setActiveDatabase, databaseReadyFor, tables, activeConnection, loadSchema, activeConnectionIdRef, activeDatabaseRef, preferredDatabaseRef, pendingDatabasePickerRef } = schema;
  const notifyScopeLocked = () => notify('Agent 正在处理', '请等当前回合完成或停止后再切换连接、数据库或会话。');
  const openPicker: Dispatch<SetStateAction<typeof picker>> = (value) => {
    const next = typeof value === 'function' ? value(picker) : value;
    if (next && next !== 'tables' && (scopeLockedRef.current || sessionMutationLockedRef.current)) {
      notifyScopeLocked();
      return;
    }
    setPicker(next);
  };
  const changeActiveConnectionId: Dispatch<SetStateAction<string | undefined>> = (value) => {
    if (scopeLockedRef.current || sessionMutationLockedRef.current) {
      notifyScopeLocked();
      return;
    }
    setActiveConnectionId(value);
  };
  const changeActiveDatabase: Dispatch<SetStateAction<string | undefined>> = (value) => {
    if (scopeLockedRef.current || sessionMutationLockedRef.current) {
      notifyScopeLocked();
      return;
    }
    setActiveDatabase(value);
  };
  const sessionStore = useSessions(client, { activeConnectionId, activeDatabase, databases, databaseReadyFor, setActiveConnectionId, setActiveDatabase, activeConnectionIdRef, preferredDatabaseRef }, { mode, setMode, live, turnRef, setLive, setApprovalQueue, setPicker, sessionMutationLockedRef, scopeLockedRef });
  const { sessions, setSessions, archivedSessions, setArchivedSessions, sessionView, setSessionView, sessionId, setSessionId, sessionMeta, setSessionMeta, messages, setMessages, sessionMutating, sessionQuery, setSessionQuery, renameTarget, setRenameTarget, sessionIdRef, refreshSessions, refreshArchivedSessions, refreshSession, openSession, newSession, deleteSession, archiveSession } = sessionStore;
  const { boot, loading, error, connected, setConnected, bootstrap, saveAgent } = useBootstrap(client, { setConnections, setSessions, setActiveConnectionId, setMode, activeConnectionIdRef, scopeLockedRef, sessionMutationLockedRef });
  const { send, stop, cancelSend, resolveApproval, sending } = useAgentSocket(client, { live, mode, input, pendingImages, uploadingImageRef, approval, approvalQueue, setSessionId, setSessionMeta, setMessages, setInput, setPendingImages, setLive, setApprovalQueue, setConnected, loadSchema, refreshSession, refreshSessions, sessionIdRef, activeConnectionIdRef, activeDatabaseRef, turnRef, sessionMutationLockedRef, scopeLockedRef });
  const scopeLocked = busy || sending;
  scopeLockedRef.current = scopeLocked;
  const interactionLocked = scopeLocked || sessionMutating;
  const { scrollRef, showJump, onChatScroll, onChatContentSizeChange, jumpToLatest } = useChatScroll({ live, messages, sessionId, busy });
  const { memories, memoryQuery, setMemoryQuery, memoryLoading, memoryDraft, setMemoryDraft, loadMemories } = useMemories(client, { tab, mePage });

  const pickImage = async () => {
    if (pickingImageRef.current || pendingImages.length >= 4) return;
    pickingImageRef.current = true;
    const available = Math.max(1, 4 - pendingImages.length);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        base64: true,
        quality: 0.8,
        allowsMultipleSelection: true,
        selectionLimit: available,
      });
      if (result.canceled || !result.assets?.length) return;
      const assets = result.assets.slice(0, available);
      uploadingImageRef.current = true;
      setUploadingImage(true);
      for (const asset of assets) {
        if (!asset.base64) continue;
        const uploaded = await client.uploadAttachment(asset.base64, asset.mimeType ?? 'image/jpeg');
        setPendingImages((prev) => prev.length >= 4 ? prev : [...prev, { id: uploaded.attachment.id, mime: uploaded.attachment.mime }]);
      }
    } catch (err: any) {
      notify('上传失败', err?.message ?? '');
    } finally {
      pickingImageRef.current = false;
      uploadingImageRef.current = false;
      setUploadingImage(false);
    }
  };

  const openTable = async (table: TableInfo, offset = 0) => {
    if (!activeConnectionId) return;
    const request = ++tableRequestRef.current;
    const connectionId = activeConnectionId;
    const database = activeDatabase;
    setSelectedTable(table);
    setDataLoading(true);
    try {
      const page = await client.data(connectionId, table.name, 50, offset, database);
      if (tableRequestRef.current !== request
        || activeConnectionIdRef.current !== connectionId
        || activeDatabaseRef.current !== database) return;
      setDataPage(page);
    } catch (err: any) {
      if (tableRequestRef.current === request) notify('加载失败', err?.message ?? '');
    } finally {
      if (tableRequestRef.current === request) setDataLoading(false);
    }
  };

  const refreshAll = async () => {
    setRefreshing(true);
    await bootstrap();
    await refreshSessions();
    if (activeConnectionIdRef.current) await loadSchema(activeConnectionIdRef.current, activeDatabaseRef.current);
    setRefreshing(false);
  };

  if (loading) return <LoadingSplash />;

  if (error) return <ErrorSplash error={error} bootstrap={bootstrap} onDisconnect={onDisconnect} />;

  const connName = activeConnection?.name ?? '未选择连接';
  const provider = boot?.settings.agent.provider === 'local' ? 'Local' : boot?.settings.agent.provider;
  const canManageHost = !config.deviceId;

  return (
    <ChartInsightContext.Provider value={{ client, connectionId: activeConnectionId, database: activeDatabase }}>
    <KeyboardAvoidingView style={styles.app} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <CommandsSheet
        commandOpen={commandOpen}
        setCommandOpen={setCommandOpen}
        insets={insets}
        setInput={setInput}
        setChatPage={setChatPage}
      />
      <View style={[styles.topSafe, { paddingTop: insets.top }]} />
      <TopBar provider={provider} connected={connected} connName={connName} />

      <View style={{ flex: 1 }}>
        {tab === 'chat' ? (
          chatPage === 'commands' ? (
            <CommandScreen client={client} connections={connections} activeConnection={activeConnection} onBack={() => setChatPage(null)} />
          ) : (
          <ChatScreen
            client={client}
            sessionMeta={sessionMeta}
            connection={activeConnection}
            connections={connections}
            sessions={sessions}
            messages={messages}
            live={live}
            input={input}
            setInput={setInput}
            mode={mode}
            setMode={setMode}
            busy={busy}
            sending={sending}
            scopeLocked={interactionLocked}
            connected={connected}
            onSend={() => void send()}
            onStop={() => void stop()}
            onCancelSend={cancelSend}
            onNew={() => void newSession()}
            onOpenSessions={() => { openPicker('sessions'); setSessionView('active'); void refreshSessions(); void refreshArchivedSessions(); }}
            onOpenConnections={() => openPicker('connections')}
            onOpenTables={() => openPicker('tables')}
            onOpenCommands={() => setCommandOpen(true)}
            onOpenRecent={(id) => void openSession(id)}
            scrollRef={scrollRef}
            onScroll={onChatScroll}
            onContentSizeChange={onChatContentSizeChange}
            showJump={showJump}
            onJumpToLatest={jumpToLatest}
            tables={tables}
            agentSettings={boot?.settings.agent}
            onSaveAgent={(patch) => void saveAgent(patch)}
            canManageHost={canManageHost}
            databases={databases}
            database={activeDatabase}
            onOpenDatabases={() => openPicker('databases')}
            pendingImages={pendingImages}
            uploadingImage={uploadingImage}
            onPickImage={() => void pickImage()}
            onRemoveImage={(id) => setPendingImages((prev) => prev.filter((item) => item.id !== id))}
          />
          )
        ) : null}

        {tab === 'data' ? (
          selectedTable ? (
            <TableDataScreen
              client={client}
              table={selectedTable}
              page={dataPage}
              loading={dataLoading}
              connection={activeConnection}
              database={activeDatabase}
              onBack={() => {
                tableRequestRef.current += 1;
                setDataLoading(false);
                setSelectedTable(null);
                setDataPage(null);
              }}
              onRefresh={() => void openTable(selectedTable, dataPage?.offset ?? 0)}
              onPage={(offset) => void openTable(selectedTable, offset)}
              onDesign={() => {
                setToolTable(selectedTable.name);
                setTab('tools');
                setToolPage('table');
              }}
              onChanged={() => void openTable(selectedTable, dataPage?.offset ?? 0)}
            />
          ) : (
            <DataScreen
              databases={databases}
              activeDatabase={activeDatabase}
              tables={tables}
              activeConnection={activeConnection}
              activeConnectionId={activeConnectionId}
              setPicker={openPicker}
              loadSchema={loadSchema}
              openTable={openTable}
              scopeLocked={interactionLocked}
            />
          )
        ) : null}

        {tab === 'tools' ? (
          <ToolsRouter
            toolPage={toolPage}
            setToolPage={setToolPage}
            client={client}
            activeConnection={activeConnection}
            activeDatabase={activeDatabase}
            tables={tables}
            toolTable={toolTable}
            toolSql={toolSql}
            setToolSql={setToolSql}
            canManageHost={canManageHost}
          />
        ) : null}

        {tab === 'me' && mePage === 'connections' ? (
          <ConnectionsScreen
            setMePage={setMePage}
            refreshing={refreshing}
            refreshAll={refreshAll}
            connections={connections}
            activeConnectionId={activeConnectionId}
            setActiveConnectionId={changeActiveConnectionId}
            setTab={setTab}
            activeDatabase={activeDatabase}
            databases={databases}
            scopeLocked={interactionLocked}
          />
        ) : null}

        {tab === 'me' && mePage === 'memory' ? (
          <MemoryScreen
            setMePage={setMePage}
            memories={memories}
            setMemoryDraft={setMemoryDraft}
            memoryQuery={memoryQuery}
            setMemoryQuery={setMemoryQuery}
            loadMemories={loadMemories}
            memoryLoading={memoryLoading}
            client={client}
          />
        ) : null}

        {tab === 'me' && mePage === 'settings' ? (
          <SettingsScreen client={client} boot={boot} config={config} mode={mode} connected={connected} onDisconnect={onDisconnect} onMode={setMode} themeMode={themeMode} resolvedTheme={resolvedTheme} onThemeMode={onThemeMode} locale={locale} onLocale={onLocale} onBack={() => setMePage(null)} canManageHost={canManageHost} />
        ) : null}

        {tab === 'me' && !mePage ? (
          <MeScreen
            boot={boot}
            config={config}
            connections={connections}
            activeConnection={activeConnection}
            memories={memories}
            connected={connected}
            themeMode={themeMode}
            locale={locale}
            canManageHost={canManageHost}
            onOpen={(page) => setMePage(page)}
          />
        ) : null}
      </View>

      <BottomTabs
        tab={tab}
        setTab={(next) => {
          if (next === 'me') setMePage(null);
          if (next === 'chat') setChatPage(null);
          setTab(next);
        }}
        busy={busy}
        bottom={insets.bottom}
      />

      {memoryDraft ? (
        <MemoryDraftSheet
          memoryDraft={memoryDraft}
          setMemoryDraft={setMemoryDraft}
          insets={insets}
          client={client}
          loadMemories={loadMemories}
        />
      ) : null}

      {picker === 'databases' ? (
        <DatabasesSheet
          setPicker={setPicker}
          insets={insets}
          activeConnection={activeConnection}
          databases={databases}
          activeDatabase={activeDatabase}
          setActiveDatabase={changeActiveDatabase}
          disabled={interactionLocked}
        />
      ) : null}

      {picker === 'sessions' ? (
        <SessionsSheet
          setPicker={setPicker}
          insets={insets}
          newSession={newSession}
          sessionQuery={sessionQuery}
          setSessionQuery={setSessionQuery}
          sessionView={sessionView}
          setSessionView={setSessionView}
          sessions={sessions}
          archivedSessions={archivedSessions}
          sessionId={sessionId}
          openSession={openSession}
          setRenameTarget={setRenameTarget}
          deleteSession={deleteSession}
          archiveSession={archiveSession}
        />
      ) : null}

      {renameTarget ? (
        <RenameSessionSheet
          renameTarget={renameTarget}
          setRenameTarget={setRenameTarget}
          client={client}
          setSessions={setSessions}
          setArchivedSessions={setArchivedSessions}
          sessionId={sessionId}
          setSessionMeta={setSessionMeta}
        />
      ) : null}

      {picker === 'connections' ? (
        <ConnectionsSheet
          setPicker={setPicker}
          insets={insets}
          connections={connections}
          activeConnectionId={activeConnectionId}
          pendingDatabasePickerRef={pendingDatabasePickerRef}
          setActiveConnectionId={changeActiveConnectionId}
          activeDatabase={activeDatabase}
          disabled={interactionLocked}
        />
      ) : null}

      {picker === 'tables' ? (
        <TablesSheet
          setPicker={setPicker}
          insets={insets}
          tables={tables}
          setInput={setInput}
        />
      ) : null}

      {approval ? (
        <ApprovalSheet
          approval={approval}
          resolveApproval={resolveApproval}
          insets={insets}
        />
      ) : null}
    </KeyboardAvoidingView>
    </ChartInsightContext.Provider>
  );
}

