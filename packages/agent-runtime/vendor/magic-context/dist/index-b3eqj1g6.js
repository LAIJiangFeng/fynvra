// ../plugin/src/shared/rpc-notifications.ts
var queue = [];
var nextNotificationId = 1;
var sinks = new Set;
function notificationMatchesSink(notification, sink) {
  if (notification.sessionId === undefined)
    return true;
  if (sink.sessionId !== undefined)
    return notification.sessionId === sink.sessionId;
  return sink.protocol !== 2;
}
function pushNotification2(type, payload, sessionId) {
  const notification = { id: nextNotificationId++, type, payload, sessionId };
  queue.push(notification);
  for (const sink of sinks) {
    if (!notificationMatchesSink(notification, sink))
      continue;
    try {
      sink.send(notification);
    } catch {}
  }
  if (queue.length > 100) {
    const reservedIds = new Set;
    const reservedScopes = new Set;
    for (let i = queue.length - 1;i >= 0 && reservedScopes.size < 25; i -= 1) {
      const candidate = queue[i];
      const scope = candidate.sessionId ?? "\x00global";
      if (reservedScopes.has(scope))
        continue;
      reservedScopes.add(scope);
      reservedIds.add(candidate.id);
    }
    const evictionIndex = queue.findIndex((candidate) => !reservedIds.has(candidate.id));
    queue.splice(evictionIndex >= 0 ? evictionIndex : 0, 1);
  }
}
function isTuiConnected2(sessionId) {
  if (sinks.size === 0)
    return false;
  if (sessionId === undefined)
    return true;
  for (const sink of sinks) {
    if (sink.sessionId === sessionId)
      return true;
    if (sink.sessionId === undefined && sink.protocol !== 2)
      return true;
  }
  return false;
}

export { pushNotification2, isTuiConnected2 };
