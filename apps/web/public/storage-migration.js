// Run synchronously before the first theme or session read. A failed copy keeps its source.
(function () {
  function migrate(storage) {
    var keys = [];
    for (var i = 0; i < storage.length; i++) {
      var key = storage.key(i);
      if (key && key.startsWith("warren.")) keys.push(key);
    }
    keys.forEach(function (key) {
      try {
        var next = "wisp." + key.slice(7);
        var value = storage.getItem(key);
        if (value !== null && storage.getItem(next) === null) storage.setItem(next, value);
        storage.removeItem(key);
      } catch (_) {} // blocked storage or quota: retry on the next startup
    });
  }
  ["localStorage", "sessionStorage"].forEach(function (name) {
    try { migrate(window[name]); } catch (_) {}
  });
})();
