/* Site navigation behaviour: mobile toggle, one dropdown open at a time. */
(function () {
  var nav = document.querySelector('.nd-nav');
  if (!nav) return;
  var toggle = nav.querySelector('.nd-toggle');
  var drops = nav.querySelectorAll('.nd-drop');
  if (toggle) toggle.addEventListener('click', function () {
    var open = nav.classList.toggle('nd-open');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  drops.forEach(function (d) {
    d.addEventListener('toggle', function () {
      if (d.open) drops.forEach(function (o) { if (o !== d) o.open = false; });
    });
  });
  function closeAll() {
    drops.forEach(function (d) { d.open = false; });
    nav.classList.remove('nd-open');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
  }
  document.addEventListener('click', function (e) { if (!nav.contains(e.target)) closeAll(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeAll(); });
})();
