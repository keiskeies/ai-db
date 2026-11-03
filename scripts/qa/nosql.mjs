import { statSync } from 'node:fs';
import { api, check, expectOk, saveReport, section, truncate } from './lib.mjs';

const REPORT = joinSafe('docs', 'test-artifacts', 'nosql.json');

function joinSafe(...parts) {
  return parts.join('/');
}

async function tool(name, args, connectionId, database) {
  return api('POST', `/agent/tools/${name}`, { args, connectionId, database });
}

async function main() {
  const connections = (await api('GET', '/connections')).json.connections;
  const qdrant = connections.find((c) => c.engine === 'qdrant');
  const es = connections.find((c) => c.engine === 'elasticsearch');
  if (!qdrant && !es) throw new Error('no non-sql connections');

  if (qdrant) {
    section('qdrant');
    const schema = await api('GET', `/connections/${qdrant.id}/schema?refresh=1`);
    const collections = schema.json?.schemas?.[0]?.tables ?? [];
    check('qdrant collections listed', schema.status === 200 && collections.length > 0, { status: schema.status, body: truncate(schema.json) });
    const collection = collections[0]?.name;
    if (collection) {
      const scroll = await api('POST', '/query', { connectionId: qdrant.id, sql: JSON.stringify({ collection, op: 'scroll', limit: 3 }), limit: 3 });
      check('qdrant scroll returns points', scroll.status === 200 && scroll.json?.batch?.sets?.[0]?.rows?.length > 0, { status: scroll.status, body: truncate(scroll.json) });
      const set = scroll.json?.batch?.sets?.[0];
      const pointId = set?.rows?.[0]?.[0];
      if (pointId !== undefined) {
        const doc = await api('GET', `/documents/get?connectionId=${qdrant.id}&collection=${encodeURIComponent(collection)}&id=${encodeURIComponent(String(pointId))}`);
        check('qdrant document read', doc.status === 200 && doc.json?.detail?.document, { status: doc.status, body: truncate(doc.json) });
      }
      const search = await api('POST', '/query', { connectionId: qdrant.id, sql: JSON.stringify({ collection, text: '测试用例平台操作手册', topK: 3 }) });
      check('qdrant text vector search', search.status === 200, { status: search.status, body: truncate(search.json) });
      const vectorSearch = await api('POST', '/vector/search', { connectionId: qdrant.id, collection, text: '知识库检索', limit: 2 });
      check('vector search endpoint', vectorSearch.status === 200, { status: vectorSearch.status, body: truncate(vectorSearch.json) });
      const sample = await tool('sample_rows', { connectionId: qdrant.id, database: schema.json?.schemas?.[0]?.name ?? 'default', table: collection, limit: 2 }, qdrant.id);
      check('tool sample_rows gives vector-specific guidance', sample.status === 400 && /vector_search|run_sql/.test(sample.json?.result?.error?.message ?? ''), { status: sample.status, body: truncate(sample.json) });
    }
  }

  if (es) {
    section('elasticsearch');
    const schema = await api('GET', `/connections/${es.id}/schema?refresh=1`);
    const indices = schema.json?.schemas?.[0]?.tables ?? [];
    check('es indices listed', schema.status === 200 && indices.length > 0, { status: schema.status, body: truncate(schema.json) });
    const index = indices.find((i) => (i.rowEstimate ?? 0) > 0)?.name ?? indices[0]?.name;
    if (index) {
      const query = { index, query: { match_all: {} }, size: 2 };
      const run = await api('POST', '/query', { connectionId: es.id, sql: JSON.stringify(query), limit: 2 });
      check('es query returns documents', run.status === 200 && run.json?.batch?.sets?.[0]?.rows?.length === 2, { status: run.status, body: truncate(run.json) });
      const id = run.json?.batch?.sets?.[0]?.rows?.[0]?.[0];
      if (id !== undefined) {
        const doc = await api('GET', `/documents/get?connectionId=${es.id}&collection=${encodeURIComponent(index)}&id=${encodeURIComponent(String(id))}`);
        check('es document read', doc.status === 200, { status: doc.status, body: truncate(doc.json) });
      }
      const exportRes = await api('POST', '/export', { connectionId: es.id, format: 'csv', sql: JSON.stringify(query), limit: 5 });
      let size = 0;
      try { size = exportRes.json?.file?.path ? statSync(exportRes.json.file.path).size : 0; } catch {}
      check('es export csv', exportRes.status === 200 && size > 0, { status: exportRes.status, file: exportRes.json?.file, size });
      const searchTool = await tool('search_index', { connectionId: es.id, index, query: '*', limit: 3 }, es.id);
      check('tool search_index on es', searchTool.status === 200 && searchTool.json?.result?.ok === true, { status: searchTool.status, body: truncate(searchTool.json) });
      const sample = await tool('sample_rows', { connectionId: es.id, database: 'default', table: index, limit: 2 }, es.id);
      check('tool sample_rows gives search-specific guidance', sample.status === 400 && /search_index|run_sql/.test(sample.json?.result?.error?.message ?? ''), { status: sample.status, body: truncate(sample.json) });
    }
  }

  saveReport(REPORT, { qdrant: qdrant?.id, es: es?.id });
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exitCode = 1;
});
