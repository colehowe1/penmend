// The right-click menu on selected text: "Rewrite with Penmend" and its styles.

/**
 * Returns build(), which (re)creates the menu from items(). Builds run one at a time: on a browser
 * start that is also an update, onStartup and onInstalled both fire, and two overlapping rebuilds
 * would each create the same ids (Chrome logs "Cannot create item with duplicate id pm-root").
 * `api` is chrome (a fake in the tests).
 */
export function menuBuilder(api, items) {
  const call = (fn, ...args) => new Promise((resolve) => {
    fn(...args, () => {
      void api.runtime.lastError; // read, so Chrome doesn't log it as unchecked
      resolve();
    });
  });
  let last = Promise.resolve();
  return () => {
    last = last.then(async () => {
      await call((cb) => api.contextMenus.removeAll(cb));
      for (const item of items()) await call((it, cb) => api.contextMenus.create(it, cb), item);
    });
    return last;
  };
}
