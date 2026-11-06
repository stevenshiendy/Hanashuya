/* Makes saving the site's photos harder: no right-click menu and no dragging on
   pictures. Text and links keep working as usual. It only deters casual copying;
   anything a browser shows can still be screenshotted. */
(function () {
  var isPicture = function (el) { return el && el.closest && el.closest('img, picture, svg, video'); };
  document.addEventListener('contextmenu', function (e) { if (isPicture(e.target)) e.preventDefault(); });
  document.addEventListener('dragstart', function (e) { if (isPicture(e.target)) e.preventDefault(); });
})();
