"use strict";

/*
  Promise wrapper for chrome.* extension APIs.

  Provides a global `browser` object that mirrors the Firefox WebExtension
  `browser.*` promise-based API surface, backed by chrome.* (callback or
  promise). This lets the popup/viewer/search pages reuse the Firefox call
  style with minimal changes while remaining correct on Chrome MV3.

  Scope: only the APIs this extension actually uses are wrapped. Unknown
  namespaces fall through to chrome.* directly (so anything not listed still
  works as long as chrome exposes it and returns a promise on Chrome 150).
*/

(function exposeBrowserCompat() {
  const hasChrome = typeof chrome !== "undefined" && chrome;

  function promisify(method, thisArg, args) {
    try {
      const maybe = method.apply(thisArg, args);
      if (maybe && typeof maybe.then === "function") {
        return maybe;
      }
    } catch (error) {
      return Promise.reject(error);
    }

    return new Promise((resolve, reject) => {
      try {
        method.apply(thisArg, [...args, (result) => {
          const err = chrome.runtime.lastError;
          if (err) {
            reject(new Error(err.message));
            return;
          }
          resolve(result);
        }]);
      } catch (error) {
        reject(error);
      }
    });
  }

  // Methods that return a value synchronously and must NOT be wrapped in a
  // promise (callers expect the value immediately, e.g. runtime.getURL).
  const SYNC_METHODS = new Set([
    "runtime.getURL",
    "runtime.getManifest",
    "runtime.getPackageDirectoryEntry",
    "runtime.id",
  ]);

  function isSyncMethod(ns, key) {
    return SYNC_METHODS.has(`${ns}.${key}`);
  }

  function wrapObject(source, ns) {
    const target = {};
    for (const key of Object.keys(source || {})) {
      const value = source[key];
      if (typeof value === "function") {
        if (ns && isSyncMethod(ns, key)) {
          target[key] = (...args) => value.apply(source, args);
        } else {
          target[key] = (...args) => promisify(value, source, args);
        }
      } else if (value && typeof value === "object" && !Array.isArray(value) && typeof value.addListener === "function") {
        // Event object: copy through unchanged (addListener/removeListener/hasListener).
        target[key] = value;
      } else {
        target[key] = value;
      }
    }
    return target;
  }

  const browser = hasChrome ? {
    runtime: wrapObject(chrome.runtime, "runtime"),
    storage: {
      local: wrapObject(chrome.storage && chrome.storage.local, "storage.local"),
      sync: wrapObject(chrome.storage && chrome.storage.sync, "storage.sync"),
      session: wrapObject(chrome.storage && chrome.storage.session, "storage.session"),
      onChanged: chrome.storage && chrome.storage.onChanged,
    },
    tabs: wrapObject(chrome.tabs, "tabs"),
    downloads: wrapObject(chrome.downloads, "downloads"),
    action: wrapObject(chrome.action, "action"),
    webRequest: chrome.webRequest,
  } : undefined;

  globalThis.browser = browser;
})();