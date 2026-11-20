import type { Dispatch, SetStateAction } from 'react';
import type { ConnectionConfig, TableInfo } from '@aidb/core';
import type { BridgeClient } from '../bridge';
import { QueryScreen } from '../screens/QueryScreen';
import { BackupScreen } from '../screens/BackupScreen';
import { DashboardScreen } from '../screens/DashboardScreen';
import { ImportExportScreen } from '../screens/ImportExportScreen';
import { TableDesignScreen } from '../screens/TableDesignScreen';
import { DictionaryScreen } from '../screens/DictionaryScreen';
import { MonitorScreen } from '../screens/MonitorScreen';
import { SearchScreen } from '../screens/SearchScreen';
import { HistoryScreen } from '../screens/HistoryScreen';
import { AuditScreen } from '../screens/AuditScreen';
import { PipelinesScreen } from '../screens/PipelinesScreen';
import { ArtifactsScreen } from '../screens/ArtifactsScreen';
import { UsersScreen } from '../screens/UsersScreen';
import { ToolsScreen } from '../screens/ToolsScreen';

export function ToolsRouter({ toolPage, setToolPage, client, activeConnection, activeDatabase, tables, toolTable, toolSql, setToolSql }: { toolPage: 'query' | 'table' | 'io' | 'backups' | 'dashboards' | 'pipelines' | 'dictionary' | 'monitor' | 'search' | 'history' | 'audit' | 'artifacts' | 'users' | null; setToolPage: Dispatch<SetStateAction<'query' | 'table' | 'io' | 'backups' | 'dashboards' | 'pipelines' | 'dictionary' | 'monitor' | 'search' | 'history' | 'audit' | 'artifacts' | 'users' | null>>; client: BridgeClient; activeConnection: ConnectionConfig | undefined; activeDatabase: string | undefined; tables: TableInfo[]; toolTable: string | undefined; toolSql: string | undefined; setToolSql: Dispatch<SetStateAction<string | undefined>> }) {
  return (
          toolPage === 'query' ? (
            <QueryScreen client={client} connection={activeConnection} database={activeDatabase} initialSql={toolSql} onBack={() => setToolPage(null)} />
          ) : toolPage === 'backups' ? (
            <BackupScreen client={client} connection={activeConnection} onBack={() => setToolPage(null)} />
          ) : toolPage === 'dashboards' ? (
            <DashboardScreen client={client} connection={activeConnection} database={activeDatabase} onBack={() => setToolPage(null)} />
          ) : toolPage === 'pipelines' ? (
            <PipelinesScreen client={client} onBack={() => setToolPage(null)} />
          ) : toolPage === 'io' ? (
            <ImportExportScreen client={client} connection={activeConnection} database={activeDatabase} tables={tables} onBack={() => setToolPage(null)} />
          ) : toolPage === 'table' ? (
            <TableDesignScreen client={client} connection={activeConnection} database={activeDatabase} tables={tables} initialTable={toolTable} onBack={() => setToolPage(null)} />
          ) : toolPage === 'dictionary' ? (
            <DictionaryScreen client={client} connection={activeConnection} database={activeDatabase} onBack={() => setToolPage(null)} />
          ) : toolPage === 'monitor' ? (
            <MonitorScreen client={client} connection={activeConnection} onBack={() => setToolPage(null)} />
          ) : toolPage === 'search' ? (
            <SearchScreen client={client} connection={activeConnection} database={activeDatabase} onBack={() => setToolPage(null)} />
          ) : toolPage === 'history' ? (
            <HistoryScreen client={client} connection={activeConnection} onBack={() => setToolPage(null)} onPick={(sql) => { setToolSql(sql); setToolPage('query'); }} />
          ) : toolPage === 'audit' ? (
            <AuditScreen client={client} connection={activeConnection} onBack={() => setToolPage(null)} />
          ) : toolPage === 'artifacts' ? (
            <ArtifactsScreen client={client} onBack={() => setToolPage(null)} />
          ) : toolPage === 'users' ? (
            <UsersScreen client={client} connection={activeConnection} onBack={() => setToolPage(null)} />
          ) : (
            <ToolsScreen
              connection={activeConnection}
              database={activeDatabase}
              tables={tables}
              onOpen={(page) => {
                if (page === 'query') setToolSql(undefined);
                setToolPage(page);
              }}
            />
          )
  );
}
