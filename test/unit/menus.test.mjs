import { test } from 'node:test';
import assert from 'node:assert/strict';
import { menuBuilder } from '../../src/background/menus.js';

/** A chrome.contextMenus stand-in that answers later, like Chrome, and refuses duplicate ids. */
function fakeChrome() {
  const ids = new Set();
  const errors = [];
  let lastError;
  let unread = 0;
  const later = (fn) => setTimeout(fn, Math.random() * 3);
  const api = {
    runtime: { get lastError() { unread = 0; return lastError; } },
    contextMenus: {
      removeAll(cb) { later(() => { ids.clear(); cb(); }); },
      create(item, cb) {
        later(() => {
          if (ids.has(item.id)) {
            lastError = { message: `Cannot create item with duplicate id ${item.id}` };
            errors.push(lastError.message);
            unread++;
          } else {
            ids.add(item.id);
            lastError = undefined;
          }
          cb();
          if (unread) errors.push('unchecked lastError');
        });
      },
    },
  };
  return { api, ids, errors };
}

const ITEMS = () => [{ id: 'root' }, { id: 'a', parentId: 'root' }, { id: 'b', parentId: 'root' }];

test('two rebuilds at once (browser start + update) never create the same id twice', async () => {
  const { api, ids, errors } = fakeChrome();
  const build = menuBuilder(api, ITEMS);
  await Promise.all([build(), build(), build()]);
  assert.deepEqual(errors, []);
  assert.deepEqual([...ids].sort(), ['a', 'b', 'root']);
});

test('a failed create is read (never "unchecked") and later builds still run', async () => {
  const { api, ids, errors } = fakeChrome();
  let calls = 0;
  const realCreate = api.contextMenus.create;
  api.contextMenus.create = (item, cb) => {
    if (item.id === 'a' && calls++ === 0) {
      setTimeout(() => {
        Object.defineProperty(api.runtime, 'lastError', { configurable: true, get: () => { errors.read = true; return { message: 'boom' }; } });
        cb();
        delete api.runtime.lastError;
      }, 1);
      return;
    }
    realCreate(item, cb);
  };
  const build = menuBuilder(api, ITEMS);
  await build();
  assert.ok(errors.read, 'the error was read');
  await build();
  assert.deepEqual([...ids].sort(), ['a', 'b', 'root']);
});
