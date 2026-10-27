import type { Engine } from './types';

export type EngineFamily = 'sqlite' | 'mysql' | 'postgres' | 'mssql' | 'oracle' | 'clickhouse';

export interface EngineMeta {
  id: Engine;
  label: string;
  family: EngineFamily;
  defaultPort?: number;
  fileBased: boolean;
  supportsSsh: boolean;
  supportsSsl: boolean;
  description: string;
  color: string;
}

export const ENGINES: EngineMeta[] = [
  { id: 'sqlite', label: 'SQLite', family: 'sqlite', fileBased: true, supportsSsh: false, supportsSsl: false, description: '嵌入式文件数据库，零服务端', color: '#38BDF8' },
  { id: 'mysql', label: 'MySQL', family: 'mysql', defaultPort: 3306, fileBased: false, supportsSsh: true, supportsSsl: true, description: '最流行的开源关系型数据库', color: '#F59E0B' },
  { id: 'mariadb', label: 'MariaDB', family: 'mysql', defaultPort: 3306, fileBased: false, supportsSsh: true, supportsSsl: true, description: 'MySQL 兼容分支，协议一致', color: '#22D3EE' },
  { id: 'postgresql', label: 'PostgreSQL', family: 'postgres', defaultPort: 5432, fileBased: false, supportsSsh: true, supportsSsl: true, description: '功能完备的开源对象关系数据库', color: '#60A5FA' },
  { id: 'cockroachdb', label: 'CockroachDB', family: 'postgres', defaultPort: 26257, fileBased: false, supportsSsh: true, supportsSsl: true, description: '云原生分布式 SQL，PG 协议兼容', color: '#A78BFA' },
  { id: 'sqlserver', label: 'SQL Server', family: 'mssql', defaultPort: 1433, fileBased: false, supportsSsh: true, supportsSsl: true, description: 'Microsoft 企业级关系数据库', color: '#EF4444' },
  { id: 'oracle', label: 'Oracle', family: 'oracle', defaultPort: 1521, fileBased: false, supportsSsh: true, supportsSsl: false, description: 'Oracle Database（thin 模式）', color: '#FB7185' },
  { id: 'clickhouse', label: 'ClickHouse', family: 'clickhouse', defaultPort: 8123, fileBased: false, supportsSsh: true, supportsSsl: true, description: '列式分析型数据库（HTTP 接口）', color: '#FACC15' },
];

export function engineMeta(engine: Engine): EngineMeta {
  return ENGINES.find((item) => item.id === engine) ?? ENGINES[0];
}

export function engineDefaultPort(engine: Engine): number | undefined {
  return engineMeta(engine).defaultPort;
}

export function isEngine(value: unknown): value is Engine {
  return typeof value === 'string' && ENGINES.some((item) => item.id === value);
}

export const ENGINE_IDS: Engine[] = ENGINES.map((item) => item.id);

export function engineUsesSchema(engine: Engine): boolean {
  return engine === 'postgresql' || engine === 'cockroachdb' || engine === 'sqlserver' || engine === 'oracle' || engine === 'clickhouse';
}
