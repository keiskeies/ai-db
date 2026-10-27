const KEYWORDS = [
  'select', 'from', 'where', 'group by', 'having', 'order by', 'limit', 'offset', 'union all', 'union',
  'left join', 'right join', 'inner join', 'outer join', 'cross join', 'join', 'on', 'values', 'set',
  'insert into', 'update', 'delete from', 'create table', 'alter table', 'drop table', 'returning', 'with',
  'as', 'and', 'or', 'not', 'null', 'asc', 'desc', 'count', 'sum', 'avg', 'min', 'max',
];

export function formatSql(input: string): string {
  let sql = input.replace(/\s+/g, ' ').trim();
  for (const keyword of ['union all', 'group by', 'order by', 'left join', 'right join', 'inner join', 'outer join', 'cross join', 'insert into', 'delete from', 'create table', 'alter table', 'drop table']) {
    sql = sql.replace(new RegExp(`\\s+${keyword}\\s+`, 'gi'), `\n${keyword.toUpperCase()} `);
  }
  for (const keyword of ['from', 'where', 'having', 'limit', 'offset', 'join', 'values', 'set', 'returning', 'union']) {
    sql = sql.replace(new RegExp(`\\s+${keyword}\\s+`, 'gi'), `\n${keyword.toUpperCase()} `);
  }
  sql = sql.replace(/,\s*(?![^()]*\))/g, ',\n  ');
  for (const keyword of KEYWORDS) {
    sql = sql.replace(new RegExp(`\\b${keyword}\\b`, 'gi'), keyword.toUpperCase());
  }
  return `${sql.replace(/\n{2,}/g, '\n')}\n`;
}
