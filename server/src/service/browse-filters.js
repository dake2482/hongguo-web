'use strict';
const RANGES = { under60: [0,3600], '60to180': [3600,10800], over180: [10800,Infinity] };
function validDuration(value) { return !value || Object.hasOwn(RANGES,value); }
function filterDurationPage(page,value) {
  if (!validDuration(value)) throw new Error('无效时长范围');
  if (!value) return page;
  const [min,max] = RANGES[value];
  // Preserve the raw upstream cursor even when every item in a page is excluded.
  return {...page,items:page.items.filter(item=>{
    const seconds = Number(item.duration);
    return Number.isFinite(seconds) && seconds > 0 && seconds >= min && seconds < max;
  })};
}
module.exports = {validDuration,filterDurationPage};
