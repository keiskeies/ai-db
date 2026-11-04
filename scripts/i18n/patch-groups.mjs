import fs from 'node:fs';

function patch(file, pairs) {
  const original = fs.readFileSync(file, 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  let text = original.split('\r\n').join('\n');
  for (const [from, to] of pairs) {
    if (!text.includes(from)) {
      console.log('MISS', file, from.slice(0, 70));
      continue;
    }
    text = text.replace(from, to);
  }
  fs.writeFileSync(file, text.split('\n').join(eol));
}

patch('apps/desktop/src/components/Sidebar.tsx', [
  [
    "import { desktopBridge, desktopDialogUi } from '../lib/desktop';",
    "import { desktopBridge, desktopDialogUi } from '../lib/desktop';\nimport { groupFromLabel, groupLabel, groupOfConnection } from '../lib/groups';",
  ],
  [
    "      const key = conn.groupName || tr(\"默认\");",
    "      const key = groupOfConnection(conn.groupName);",
  ],
  [
    "    const next = await askPrompt({ title: tr(\"重命名分组\"), message: tr(\"分组「{0}」重命名为：\", [group]), value: group, confirmLabel: tr(\"重命名\") });\n    if (!next || !next.trim() || next.trim() === group) return;\n    try {\n      await api.renameGroup(group, next.trim());\n      await useApp.getState().boot();\n      notify('success', tr(\"分组已重命名\"), next.trim());",
    "    const next = await askPrompt({ title: tr(\"重命名分组\"), message: tr(\"分组「{0}」重命名为：\", [groupLabel(group)]), value: groupLabel(group), confirmLabel: tr(\"重命名\") });\n    const renamed = groupFromLabel((next ?? '').trim());\n    if (!renamed || renamed === group) return;\n    try {\n      await api.renameGroup(group, renamed);\n      await useApp.getState().boot();\n      notify('success', tr(\"分组已重命名\"), groupLabel(renamed));",
  ],
  [
    "    if (!conn || (conn.groupName || tr(\"默认\")) === group) return;",
    "    if (!conn || groupOfConnection(conn.groupName) === group) return;",
  ],
  [
    "    if (!(await askConfirm({ message: tr(\"删除分组「{0}」？\", [group]), detail:",
    "    if (!(await askConfirm({ message: tr(\"删除分组「{0}」？\", [groupLabel(group)]), detail:",
  ],
  [
    "                      if ((source.groupName || tr(\"默认\")) !== (conn.groupName || tr(\"默认\"))) {\n                        void moveConnectionToGroup(draggedId, conn.groupName || tr(\"默认\"));",
    "                      if (groupOfConnection(source.groupName) !== groupOfConnection(conn.groupName)) {\n                        void moveConnectionToGroup(draggedId, groupOfConnection(conn.groupName));",
  ],
  [
    "              {group === '默认' || group === '示例' ? tr(group) : group}",
    "              {groupLabel(group)}",
  ],
]);

patch('apps/desktop/src/components/ConnectionModal.tsx', [
  [
    "  const [groupName, setGroupName] = useState(c?.groupName ?? tr(\"默认\"));",
    "  const [groupName, setGroupName] = useState(c?.groupName ?? '默认');",
  ],
  [
    "      groupName: groupName.trim() || tr(\"默认\"),",
    "      groupName: groupName.trim() || '默认',",
  ],
  [
    "            <input className=\"input\" value={groupName} onChange={(e) => setGroupName(e.target.value)} />",
    "            <input className=\"input\" value={groupLabel(groupName)} onChange={(e) => setGroupName(groupFromLabel(e.target.value))} />",
  ],
]);

const modal = 'apps/desktop/src/components/ConnectionModal.tsx';
const text = fs.readFileSync(modal, 'utf8');
if (!text.includes("from '../lib/groups'")) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  let lastImport = -1;
  lines.forEach((line, index) => {
    if (line.startsWith('import ')) lastImport = index;
  });
  if (lastImport >= 0) {
    lines.splice(lastImport + 1, 0, "import { groupFromLabel, groupLabel } from '../lib/groups';");
    fs.writeFileSync(modal, lines.join(eol));
    console.log('groups import added');
  }
}
