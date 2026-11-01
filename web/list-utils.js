(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HGListUtils = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  function uniqueSeries(items, previous = []) {
    const seen = new Set(previous);
    return (items || []).filter(item => {
      if (!item || item.series_id == null || item.series_id === '') return false;
      const id = String(item.series_id);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }
  return { uniqueSeries };
});
