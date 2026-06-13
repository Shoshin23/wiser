/* wiser ambient — opportunity-card renderer.
   Augments window.WISER (alongside the reused contract.js / cards.js) with a
   renderer for the new `opportunity` card kind. Built from the same .card /
   .focusable primitives so it matches the dreamy theme, plus swipe + buttons.

   W.renderOpportunity(opp, handlers) -> focusable .card element
     opp      = { title, summary, proposedPrompt }
     handlers = { onApprove(), onDismiss(), onEdit() }
   Swipe right = approve, swipe left = dismiss (pointer drag past threshold).
*/
(function () {
  "use strict";
  var W = (window.WISER = window.WISER || {});
  var el = W.el || function (tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls; if (text != null) n.textContent = text; return n;
  };

  var SWIPE_THRESHOLD = 80;

  W.renderOpportunity = function (opp, handlers) {
    handlers = handlers || {};
    var root = el("div", "card opp-card focusable");
    root.setAttribute("tabindex", "0");

    root.appendChild(el("div", "opp-eyebrow", "◆ opportunity"));
    root.appendChild(el("div", "opp-title", opp.title || "Task"));
    if (opp.summary) root.appendChild(el("div", "opp-summary", opp.summary));
    if (opp.proposedPrompt) root.appendChild(el("div", "opp-prompt clamp2", opp.proposedPrompt));

    var actions = el("div", "opp-actions");
    var dismiss = el("button", "opp-btn dismiss", "✗ dismiss");
    var edit = el("button", "opp-btn edit", "✎ edit");
    var approve = el("button", "opp-btn approve", "✓ approve");
    dismiss.addEventListener("click", function (e) { e.stopPropagation(); fire(handlers.onDismiss); });
    edit.addEventListener("click", function (e) { e.stopPropagation(); fire(handlers.onEdit); });
    approve.addEventListener("click", function (e) { e.stopPropagation(); fire(handlers.onApprove); });
    actions.appendChild(dismiss); actions.appendChild(edit); actions.appendChild(approve);
    root.appendChild(actions);

    wireSwipe(root, handlers);
    return root;
  };

  function fire(fn) { if (typeof fn === "function") fn(); }

  // Pointer-drag swipe: follow the finger, commit past the threshold.
  // Horizontal = approve (right) / dismiss (left); vertical = browse prev (up) / next (down).
  function wireSwipe(node, handlers) {
    var startX = 0, startY = 0, dx = 0, dy = 0, dragging = false, horizontal = false;
    node.addEventListener("pointerdown", function (e) {
      if (e.target.closest(".opp-btn")) return; // let buttons handle their own clicks
      dragging = true; horizontal = false; startX = e.clientX; startY = e.clientY; dx = 0; dy = 0;
      try { node.setPointerCapture(e.pointerId); } catch (_) {}
      node.style.transition = "none";
    });
    node.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      dx = e.clientX - startX; dy = e.clientY - startY;
      horizontal = Math.abs(dx) >= Math.abs(dy);
      if (horizontal) {
        node.style.transform = "translateX(" + dx + "px) rotate(" + (dx / 40) + "deg)";
        node.style.opacity = String(Math.max(0.35, 1 - Math.abs(dx) / 400));
      } else {
        node.style.transform = "translateY(" + (dy / 3) + "px)"; // gentle hint; the switch happens on release
      }
    });
    function end() {
      if (!dragging) return;
      dragging = false;
      node.style.transition = "";
      if (horizontal && dx > SWIPE_THRESHOLD) fire(handlers.onApprove);
      else if (horizontal && dx < -SWIPE_THRESHOLD) fire(handlers.onDismiss);
      else if (!horizontal && dy < -SWIPE_THRESHOLD) fire(handlers.onPrev);
      else if (!horizontal && dy > SWIPE_THRESHOLD) fire(handlers.onNext);
      else { node.style.transform = ""; node.style.opacity = ""; } // snap back
    }
    node.addEventListener("pointerup", end);
    node.addEventListener("pointercancel", end);
  }
})();
