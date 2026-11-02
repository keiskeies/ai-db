import type { Engine } from '@aidb/core';
import { engineMeta } from '@aidb/core';

import arangodb from '../assets/engines/arangodb.svg';
import cassandra from '../assets/engines/cassandra.svg';
import clickhouse from '../assets/engines/clickhouse.svg';
import cockroachdb from '../assets/engines/cockroachdb.svg';
import dm from '../assets/engines/dm.png';
import doris from '../assets/engines/doris.svg';
import duckdb from '../assets/engines/duckdb.svg';
import elasticsearch from '../assets/engines/elasticsearch.svg';
import falkordb from '../assets/engines/falkordb.svg';
import gbase from '../assets/engines/gbase.png';
import gaussdb from '../assets/engines/gaussdb.png';
import goldendb from '../assets/engines/goldendb.png';
import greatsql from '../assets/engines/greatsql.png';
import influxdb from '../assets/engines/influxdb.svg';
import ivorysql from '../assets/engines/ivorysql.svg';
import kingbase from '../assets/engines/kingbase.png';
import mariadb from '../assets/engines/mariadb.svg';
import memgraph from '../assets/engines/memgraph.svg';
import milvus from '../assets/engines/milvus.svg';
import mongodb from '../assets/engines/mongodb.svg';
import mysql from '../assets/engines/mysql.svg';
import neo4j from '../assets/engines/neo4j.svg';
import oceanbase from '../assets/engines/oceanbase.png';
import opengauss from '../assets/engines/opengauss.png';
import opensearch from '../assets/engines/opensearch.svg';
import oracle from '../assets/engines/oracle.svg';
import polardb from '../assets/engines/polardb.png';
import postgresql from '../assets/engines/postgresql.svg';
import qdrant from '../assets/engines/qdrant.svg';
import redis from '../assets/engines/redis.svg';
import scylla from '../assets/engines/scylla.svg';
import sqlite from '../assets/engines/sqlite.svg';
import sqlserver from '../assets/engines/sqlserver.svg';
import starrocks from '../assets/engines/starrocks.svg';
import tdengine from '../assets/engines/tdengine.png';
import tidb from '../assets/engines/tidb.svg';
import timescale from '../assets/engines/timescale.svg';
import weaviate from '../assets/engines/weaviate.svg';

/**
 * 各引擎的官方品牌 logo（SVG/PNG 全部随应用打包在本地，不依赖网络）。
 * 单色 mark 来自 Simple Icons，并烘焙了官方品牌色；彩色 mark 取自各项目官网/GitHub 官方资产。
 */
const ENGINE_LOGOS: Partial<Record<Engine, string>> = {
  sqlite,
  mysql,
  mariadb,
  postgresql,
  cockroachdb,
  sqlserver,
  oracle,
  clickhouse,
  mongodb,
  redis,
  neo4j,
  memgraph,
  dm,
  qdrant,
  milvus,
  weaviate,
  duckdb,
  cassandra,
  scylla,
  elasticsearch,
  opensearch,
  kingbase,
  opengauss,
  gaussdb,
  oceanbase,
  tidb,
  polardb,
  gbase8a: gbase,
  doris,
  starrocks,
  ivorysql,
  greatsql,
  goldendb,
  tdengine,
  falkordb,
  influxdb,
  arangodb,
  timescale,
};

/**
 * 官方 logo 本身接近黑色（SQLite、MariaDB、Elasticsearch、IvorySQL），
 * 直接铺在深色面板上几乎不可见，暗色下改用官方白色变体的单色渲染。
 */
const MONO_ON_DARK = new Set<Engine>(['sqlite', 'mariadb', 'elasticsearch', 'ivorysql']);

/** 品牌色本身偏亮（黄/浅金/浅青），白色面板上对比不足，亮色下额外压暗一档。 */
const BRIGHT_ON_LIGHT = new Set<Engine>(['arangodb', 'goldendb', 'duckdb', 'clickhouse', 'timescale', 'scylla', 'weaviate', 'gaussdb']);

/** 这些品牌没有可用的方形官方 mark（仅中文文字标或未公开 mark），用品牌色 + 首字母徽标兜底。 */
const LETTER_BADGES: Partial<Record<Engine, { letter: string; color: string }>> = {
  tdsql: { letter: 'T', color: '#0891B2' },
  highgo: { letter: 'H', color: '#14B8A6' },
  vastbase: { letter: 'V', color: '#6366F1' },
};

export function EngineIcon({ engine, size = 16 }: { engine: Engine; size?: number }) {
  const label = engineMeta(engine).label;
  const logo = ENGINE_LOGOS[engine];

  if (!logo) {
    const badge = LETTER_BADGES[engine];
    return (
      <span
        className="conn-engine conn-engine-letter"
        style={{ color: badge?.color ?? 'var(--text-muted)' }}
        title={label}
        aria-label={label}
      >
        <span aria-hidden="true">{badge?.letter ?? '?'}</span>
      </span>
    );
  }

  const className = `conn-engine${MONO_ON_DARK.has(engine) ? ' conn-engine-mono' : ''}${BRIGHT_ON_LIGHT.has(engine) ? ' conn-engine-bright' : ''}`;

  return (
    <span className={className} title={label} aria-label={label}>
      <img src={logo} alt="" width={size} height={size} draggable={false} />
    </span>
  );
}
