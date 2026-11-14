import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isNativeAbsolutePath } from '../../../../src/features/provider-session-implementation/adapters/provider-session-io/native-path.ts';

test('native path admission keeps real Windows drive identity and refuses aliases', () => {
  for (const value of ['C:\\TEST\\provider.exe', 'D:\\Тест с пробелом\\проект', 'C:\\TEST\\attachments\\image.png']) {
    assert.equal(isNativeAbsolutePath(value, 'win32'), true, value);
    assert.equal(isNativeAbsolutePath(value, 'linux'), false, value);
  }
  for (const value of ['/fake/windows', 'C:relative', 'C:\\', '\\\\server\\share', '\\\\?\\C:\\TEST',
    'C:/TEST', 'C:\\TEST\\..\\other', 'C:\\TEST\\NUL.txt', 'C:\\TEST\\file:stream', 'C:\\TEST\\tail.',
    'C:\\TEST\\tail ', 'C:\\TEST\\bad\0value']) {
    assert.equal(isNativeAbsolutePath(value, 'win32'), false, JSON.stringify(value));
  }
  assert.equal(isNativeAbsolutePath('/TEST/workspace', 'linux'), true);
  assert.equal(isNativeAbsolutePath('/TEST/workspace', 'darwin'), true);
  assert.equal(isNativeAbsolutePath('relative', 'linux'), false);
  assert.equal(isNativeAbsolutePath('/TEST\0invalid', 'linux'), false);
});
