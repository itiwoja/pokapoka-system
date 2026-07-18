(function attachLogic(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }

  root.PokapokaLogic = factory();
})(typeof globalThis !== "undefined" ? globalThis : window, function createLogic() {
  const MINUTE_MS = 60000;
  const DEFAULT_TASTE_TIMER_MS = 120000;

  function elapsedMinutes(timestamp, now = new Date()) {
    return Math.max(0, Math.floor((now.getTime() - timestamp.getTime()) / MINUTE_MS));
  }

  function getTimeLevel(minutes) {
    if (minutes <= 5) return "time-ok";
    if (minutes <= 10) return "time-warn";
    return "time-alert";
  }

  function getAlertableOrderIds(orders, now = new Date(), alertedIds = new Set()) {
    return orders
      .filter((order) => elapsedMinutes(order.timestamp, now) > 10 && !alertedIds.has(order.id))
      .map((order) => order.id);
  }

  function markAlerted(previousIds, ids) {
    return new Set([...previousIds, ...ids]);
  }

  function completeOrder(activeOrders, completedOrders, id, now = new Date()) {
    const completed = activeOrders.find((order) => order.id === id);
    if (!completed) {
      return {
        activeOrders: [...activeOrders],
        completedOrders: [...completedOrders],
      };
    }

    return {
      activeOrders: activeOrders.filter((order) => order.id !== id),
      completedOrders: [
        ...completedOrders,
        {
          ...completed,
          completedAt: now,
          durationMinutes: elapsedMinutes(completed.timestamp, now),
        },
      ],
    };
  }

  function getSummaryMetrics(completedOrders) {
    const completedCount = completedOrders.length;
    const totalDuration = completedOrders.reduce(
      (sum, order) => sum + Number(order.durationMinutes || 0),
      0,
    );

    return {
      completedCount,
      averageDurationMinutes: completedCount ? Math.round(totalDuration / completedCount) : 0,
    };
  }

  function startTasteTimer(timers, orderId, now = new Date(), durationMs = DEFAULT_TASTE_TIMER_MS) {
    return {
      ...timers,
      [orderId]: {
        startedAt: now,
        endsAt: new Date(now.getTime() + durationMs),
        durationMs,
      },
    };
  }

  function remainingTasteSeconds(timer, now = new Date()) {
    if (!timer) return 0;
    return Math.max(0, Math.ceil((timer.endsAt.getTime() - now.getTime()) / 1000));
  }

  return {
    completeOrder,
    elapsedMinutes,
    getAlertableOrderIds,
    getSummaryMetrics,
    getTimeLevel,
    markAlerted,
    remainingTasteSeconds,
    startTasteTimer,
  };
});
