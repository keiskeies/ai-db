import test from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_PERMISSION_MODES, isDevicePermissionMode, type PermissionMode } from '../src/types';

test('device permission modes only include readonly and ask', () => {
  assert.deepEqual(DEVICE_PERMISSION_MODES, ['readonly', 'ask']);
  for (const mode of DEVICE_PERMISSION_MODES) assert.equal(isDevicePermissionMode(mode), true);
  for (const mode of ['auto', 'full'] satisfies PermissionMode[]) {
    assert.equal(isDevicePermissionMode(mode), false);
  }
});
