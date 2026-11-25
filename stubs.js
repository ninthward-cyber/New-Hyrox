/*
 * integrations/stubs.js - documented interfaces for owner-gated integrations.
 * NONE are active. Each method resolves {ok:false, code:'NOT_ACTIVATED'} and makes no network call.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HyroxIntegrations = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  function off(name) { return function () { return Promise.resolve({ ok: false, code: 'NOT_ACTIVATED', message: name + ' is not activated (owner approval required).' }); }; }
  var REGISTRY = [
    { id: 'owner-auth', name: 'Owner-only login', status: 'NOT ACTIVATED (stub)', note: 'Interface: signIn(), signOut(), currentUser(). Provider and hosting are owner decisions.',
      api: { signIn: off('Owner login'), signOut: off('Owner login'), currentUser: off('Owner login') } },
    { id: 'cloud-sync', name: 'Cloud sync / backup', status: 'NOT ACTIVATED (stub)', note: 'Interface: push(hyroxV1Json), pull() -> hyroxV1Json. Must reuse previewImport/applyImport for any restore.',
      api: { push: off('Cloud sync'), pull: off('Cloud sync') } },
    { id: 'health-import', name: 'Garmin / Apple Health import', status: 'NOT ACTIVATED (stub)', note: 'Interface: fetchDaily(fromDate, toDate) -> [{date, steps, sleepH, rhr}] mapped to daily records with source provenance.',
      api: { fetchDaily: off('Health import') } },
    { id: 'food-catalogue', name: 'Licensed food catalogue', status: 'NOT ACTIVATED (stub)', note: 'Interface: search(text) -> [{name, per100g macros, licence}]. Licence/source decision pending.',
      api: { search: off('Food catalogue') } },
    { id: 'text-ai', name: 'Description-only AI estimate', status: 'NOT ACTIVATED (stub)', note: 'Interface mirrors photo adapter (validateResult schema). Not billed or called.',
      api: { estimate: off('Description AI') } }
  ];
  return { list: function () { return REGISTRY.map(function (r) { return { id: r.id, name: r.name, status: r.status, note: r.note }; }); },
    get: function (id) { var r = REGISTRY.filter(function (x) { return x.id === id; })[0]; return r ? r.api : null; } };
});
